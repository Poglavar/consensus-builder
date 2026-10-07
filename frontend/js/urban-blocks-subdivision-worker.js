// Keep subdivision candidate generation and the bounded combinatorial search off the UI thread.
(function () {
    const build = new URL(self.location.href).searchParams.get('build') || '';
    importScripts(`../vendor/turf-6.5.0/turf.min.js?build=${encodeURIComponent(build)}`,
        `urban-blocks-model.js?build=${encodeURIComponent(build)}`,
        `urban-blocks-subdivision.js?build=${encodeURIComponent(build)}`);
    let source = null, prepared = null;
    self.onmessage = ({ data }) => {
        try {
            if (data.block) { source = { block: data.block, roads: data.roads }; prepared = null; }
            const input = { ...source, ...data }, api = self.UrbanBlocksSubdivision;
            let result;
            if (data.action === 'preview') {
                prepared ||= api.prepare(input, self.turf, self.UrbanBlocksModel);
                result = api.preview(input, self.turf, self.UrbanBlocksModel, prepared);
            } else if (data.action === 'restore') result = api.restore(input, self.turf);
            else if (data.action === 'plan') result = api.plan(input, self.turf, self.UrbanBlocksModel);
            else throw new Error('Unknown subdivision request.');
            self.postMessage({ action: data.action, request: data.request, result });
        } catch (error) {
            self.postMessage({ action: data.action, request: data.request, error: error.message });
        }
    };
})();
