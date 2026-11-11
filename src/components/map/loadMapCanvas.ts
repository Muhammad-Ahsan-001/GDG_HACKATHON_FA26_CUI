/**
 * Loader for the citizen map's Leaflet canvas chunk (MapCanvas + leaflet + markercluster).
 * App.tsx starts it together with the MapPage chunk, so both download in parallel (no waterfall),
 * while the page shell can render before Leaflet has been parsed. The browser caches the module promise.
 */
export const loadMapCanvas = () => import('./MapCanvas')
