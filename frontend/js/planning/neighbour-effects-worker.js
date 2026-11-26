// Runs the neighbour effects assessment (neighbour-effects.js) off the page's thread: a dense street
// takes most of a second, which would stall drawing. One message in ({ id, input }), one out.
importScripts('neighbour-effects.js' + self.location.search);
self.onmessage = ({ data }) => {
    try { self.postMessage({ id: data.id, result: self.NeighbourEffects.assess(data.input) }); }
    catch (error) { self.postMessage({ id: data.id, error: error && error.message ? error.message : String(error) }); }
};
