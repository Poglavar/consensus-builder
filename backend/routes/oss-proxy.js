const OSS_WFS_BASE = 'https://oss.uredjenazemlja.hr/OssWebServices/wfs';
const OSS_OWNERSHIP_BASE = 'https://oss.uredjenazemlja.hr/oss/public/cad/parcel-info';

export function setupOssProxyRoute(app) {
    // Proxy for WFS requests
    app.get('/oss/wfs', async (req, res) => {
        const token = process.env.OSS_TOKEN;
        if (!token) {
            console.error('OSS WFS Proxy Error: OSS_TOKEN environment variable is not set');
            return res.status(500).json({ error: 'Internal server error: OSS_TOKEN not configured' });
        }
        try {
            const params = new URLSearchParams(req.query);
            // Always override or set the token from our secure environment
            params.set('token', token);

            const url = `${OSS_WFS_BASE}?${params.toString()}`;
            const response = await fetch(url);

            const contentType = response.headers.get('content-type');
            const buffer = await response.arrayBuffer();

            if (contentType) {
                res.setHeader('Content-Type', contentType);
            }
            res.status(response.status).send(Buffer.from(buffer));
        } catch (error) {
            console.error('OSS WFS Proxy Error:', error);
            res.status(500).json({ error: 'Failed to proxy request to OSS WFS' });
        }
    });

    // Proxy for Parcel Info (Ownership) requests
    app.get('/oss/parcel-info', async (req, res) => {
        const token = process.env.OSS_TOKEN;
        if (!token) {
            console.error('OSS Parcel Info Proxy Error: OSS_TOKEN environment variable is not set');
            return res.status(500).json({ error: 'Internal server error: OSS_TOKEN not configured' });
        }
        try {
            const params = new URLSearchParams(req.query);
            // Always override or set the token from our secure environment
            params.set('token', token);

            const url = `${OSS_OWNERSHIP_BASE}?${params.toString()}`;
            const response = await fetch(url);

            const contentType = response.headers.get('content-type');
            const buffer = await response.arrayBuffer();

            if (contentType) {
                res.setHeader('Content-Type', contentType);
            }
            res.status(response.status).send(Buffer.from(buffer));
        } catch (error) {
            console.error('OSS Parcel Info Proxy Error:', error);
            res.status(500).json({ error: 'Failed to proxy request to OSS Parcel Info' });
        }
    });
}
