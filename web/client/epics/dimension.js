
const { Observable } = require('rxjs');
const { updateLayerDimension, changeLayerProperties, ADD_LAYER} = require('../actions/layers');
const {MAP_CONFIG_LOADED} = require('../actions/config');

const { SET_CURRENT_TIME, MOVE_TIME, SET_OFFSET_TIME, updateLayerDimensionData} = require('../actions/dimension');
const { layersWithTimeDataSelector, offsetTimeSelector, currentTimeSelector } = require('../selectors/dimension');
const {describeDomains} = require('../api/MultiDim');
const { castArray, pick, find, replace, endsWith, get } = require('lodash');
/**
 * Tries to get the layer's information form the URL.
 * TODO: find out a better way to do this
 * @param {string} url the wms layers wms URL
 */
const getMultidimURL = ({url} = {}) =>
    endsWith(url, "/wms")
        ? replace(url, "/wms", "/gwc/service/wmts")
        : endsWith(url, "/ows")
            ? replace(url, "/ows", "/gwc/service/wmts")
            : url;

const DESCRIBE_DOMAIN_OPTIONS = {
    expandLimit: 10 // TODO: increase this limit to max client allowed
};

const domainsToDimensionsObject = ({ Domains = {} } = {}, url) => {
    const dimensions = castArray(Domains.DimensionDomain || []);
    return dimensions.map( ({Identifier: name, Domain: domain} ) => ({
        source: {
            type: "multidim-extension",
            url
        },
        name,
        domain
    }));
};
const getTimeMultidimURL = (l = {}) => get(find(l.dimensions || [], d => d && d.source && d.source.type === "multidim-extension"), "source.url");
module.exports = {
    /**
     * Sync current time param of the layer with the current time element
     */
    updateLayerDimensionOnCurrentTimeSelection: (action$, { getState = () => { } } = {}) =>
        action$.ofType(SET_CURRENT_TIME, SET_OFFSET_TIME, MOVE_TIME).switchMap(() => {
            const currentTime = currentTimeSelector(getState());
            const offsetTime = offsetTimeSelector(getState());
            const time = offsetTime ? `${currentTime}/${offsetTime}` : currentTime;
            return Observable.of(updateLayerDimension('time', time));
        }),

    /**
     * Check the presence of Multidimensional API extension, then setup layers properly.
     * Updates also current dimension state
     */
    queryMultidimensionalAPIExtensionOnAddLayer: action$ =>
        action$
            .ofType(ADD_LAYER)
            .filter(
                    ({ layer = {} } = {}) => layer.id && layer.url && layer.name && (layer.type === "wms" || layer.type === "wmts")
            )
            // find out possible multidim URL
            // TODO: find out a better way to extract or discover multidim URL
            .map(({ layer = {} } = {}) => ({ layer, multidimURL: getMultidimURL(layer)}))
            // every add layer has it's own flow, this is why it uses
            .flatMap(({ layer = {}, multidimURL } = {}) =>
                describeDomains(multidimURL, layer.name, undefined, DESCRIBE_DOMAIN_OPTIONS)
                    .switchMap( domains => {
                        const dimensions = domainsToDimensionsObject(domains, multidimURL);
                        if (dimensions && dimensions.length > 0) {
                            /**
                             * updating the time object in state.layers (from describeDomains),
                             * while maintaining other dimensions information in state.layer,
                             * it also creates a list of dimensions (from describeDomains) in state.dimensions.
                             *  */
                            const timeDimensionData = find(dimensions, d => d.name === 'time');
                            if (timeDimensionData) {
                                const newDimensions = [...(layer.dimensions || []).filter(dimension => dimension.name === 'time'), timeDimensionData];
                                return Observable.of(
                                    changeLayerProperties(layer.id, {
                                        dimensions: newDimensions.map(d => d.name === 'time' ? pick(d, ['source', 'name']) : d)
                                    }),
                                    ...dimensions.map(d => updateLayerDimensionData(layer.id, d.name, d)));
                            }

                        }
                        return Observable.empty();
                    })
                    // no multi-dimension support
                    .catch(() => Observable.empty()) ),
    /**
     * Updates dimension state for layers that has multidimensional extension.
     */
    updateLayerDimensionDataOnMapLoad: (action$, {getState = () => {}} = {}) =>
            action$.ofType(MAP_CONFIG_LOADED).switchMap( () => {
                const layers = layersWithTimeDataSelector(getState());
                return Observable.from(
                        // layers with dimension and multidimensional extension
                        layers.filter(l =>
                            l
                            && l.dimensions
                            && find(l.dimensions, d => d && d.source && d.source.type === "multidim-extension")
                        )
                    )
                    // one flow for each dimension
                    .flatMap(l =>
                        describeDomains(getTimeMultidimURL(l), l.name, undefined, DESCRIBE_DOMAIN_OPTIONS)
                            .switchMap( domains =>
                                Observable.from(domainsToDimensionsObject(domains, getTimeMultidimURL(l))
                                    .map(d => updateLayerDimensionData(l.id, d.name, d))
                            )
                        )
                    );
            })
};
