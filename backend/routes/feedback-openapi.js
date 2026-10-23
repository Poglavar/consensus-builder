// The private feedback API is discoverable alongside the public read/publish APIs.
export const FEEDBACK_PATHS = {
    '/feedback': { post: { summary: 'Send feedback or a bug report to the private maintainer inbox; returns a receipt, never publishes the report',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['kind', 'message'], properties: {
            kind: { type: 'string', enum: ['bug', 'feedback'] }, message: { type: 'string', minLength: 1, maxLength: 8000 },
            pageUrl: { type: 'string', format: 'uri', maxLength: 2048 }, reportId: { type: 'string', format: 'uuid', description: 'Keep the same UUID when retrying the same report.' },
            source: { type: 'string', enum: ['web', 'mcp', 'api'], default: 'api' }
        } } } } }, responses: { 201: { description: 'Receipt: report { id, status: received, createdAt }. Reports are private and not publicly listed.' },
            400: { description: 'Invalid report.' }, 409: { description: 'reportId already used for different content.' }, 429: { description: 'Rate limited; retry later.' }, 503: { description: 'Not saved; retry with the same reportId.' } } } },
};
