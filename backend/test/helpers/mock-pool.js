export function createMockPool() {
    const calls = [];
    let results = [];

    return {
        async query(sql, params) {
            calls.push({ sql, params });
            if (results.length > 0) {
                return results.shift();
            }
            return { rows: [], rowCount: 0 };
        },

        setResult(result) {
            results = [result];
        },

        setResults(resultList) {
            results = [...resultList];
        },

        getCalls() {
            return calls;
        },

        reset() {
            calls.length = 0;
            results = [];
        },
    };
}
