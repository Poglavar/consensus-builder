// CityJSON building reader for the backend: the shared reader of frontend/js/city-model-reader.js
// (CityJSON documents and CityJSONFeatures → the shared building shape).
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const { parseCityJson } = require('../../frontend/js/city-model-reader.js');
