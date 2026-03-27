import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { marked } from 'marked';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Cache for database schema to serve previous version if refresh fails
let cachedDatabaseSchema = null;
let lastDatabaseRefresh = null;
const DATABASE_CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

export function setupDocsRoute(app, pool) {
    // GET /docs - General documentation (markdown converted to HTML)
    app.get('/docs', (req, res) => {
        try {
            const docsPath = path.join(__dirname, 'docs.md');
            const markdownContent = fs.readFileSync(docsPath, 'utf8');

            // Process the markdown content to replace $(date) with actual date
            const processedContent = markdownContent.replace(/\$\(date\)/g, new Date().toLocaleDateString());

            // Convert markdown to HTML
            const htmlContent = marked(processedContent);

            // Create a complete HTML page with styling
            const fullHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Consensus Builder API Documentation</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 1200px;
            margin: 0 auto;
            padding: 20px;
            background-color: #f8f9fa;
        }
        .container {
            background: white;
            padding: 40px;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        h1 {
            color: #2c3e50;
            border-bottom: 3px solid #3498db;
            padding-bottom: 10px;
            margin-bottom: 30px;
        }
        h2 {
            color: #34495e;
            margin-top: 30px;
            margin-bottom: 15px;
        }
        h3 {
            color: #7f8c8d;
            margin-top: 25px;
            margin-bottom: 10px;
        }
        code {
            background-color: #f1f2f6;
            padding: 2px 6px;
            border-radius: 4px;
            font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
            font-size: 0.9em;
        }
        pre {
            background-color: #2c3e50;
            color: #ecf0f1;
            padding: 20px;
            border-radius: 6px;
            overflow-x: auto;
            margin: 15px 0;
        }
        pre code {
            background: none;
            color: inherit;
            padding: 0;
        }
        ul, ol {
            margin: 15px 0;
            padding-left: 30px;
        }
        li {
            margin: 8px 0;
        }
        a {
            color: #3498db;
            text-decoration: none;
        }
        a:hover {
            text-decoration: underline;
        }
        .endpoint {
            background-color: #e8f4f8;
            border-left: 4px solid #3498db;
            padding: 15px;
            margin: 10px 0;
            border-radius: 0 4px 4px 0;
        }
        .feature-list {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 20px;
            margin: 20px 0;
        }
        .feature-card {
            background: #f8f9fa;
            padding: 20px;
            border-radius: 6px;
            border: 1px solid #e9ecef;
        }
        .badge {
            display: inline-block;
            background: #3498db;
            color: white;
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 0.8em;
            margin-right: 8px;
        }
        .footer {
            margin-top: 40px;
            padding-top: 20px;
            border-top: 1px solid #e9ecef;
            color: #6c757d;
            font-size: 0.9em;
        }
    </style>
</head>
<body>
    <div class="container">
        ${htmlContent}
        <div class="footer">
            <p><strong>Quick Links:</strong> 
                <a href="/docs/api">API Schema (JSON)</a> | 
                <a href="/docs/database">Database Schema (JSON)</a> | 
                <a href="/health">Health Check</a>
            </p>
        </div>
    </div>
</body>
</html>`;

            res.setHeader('Content-Type', 'text/html');
            res.send(fullHtml);
        } catch (error) {
            console.error('Error reading docs.md:', error);
            res.status(500).json({ error: 'Failed to load documentation' });
        }
    });

    // GET /docs/api - API schema (OpenAPI compatible)
    app.get('/docs/api', (req, res) => {
        try {
            const apiSchemaPath = path.join(__dirname, 'api-schema.json');
            const apiSchema = JSON.parse(fs.readFileSync(apiSchemaPath, 'utf8'));

            // Set proper content type for OpenAPI
            res.setHeader('Content-Type', 'application/json');
            res.json(apiSchema);
        } catch (error) {
            console.error('Error reading API schema:', error);
            res.status(500).json({ error: 'Failed to load API schema' });
        }
    });

    // GET /docs/database - Database schema from information_schema
    app.get('/docs/database', async (req, res) => {
        try {
            const now = Date.now();

            // Check if we need to refresh the cache
            if (!cachedDatabaseSchema || !lastDatabaseRefresh ||
                (now - lastDatabaseRefresh) > DATABASE_CACHE_DURATION) {

                console.log('Refreshing database schema cache...');
                const freshSchema = await generateDatabaseSchema(pool);
                cachedDatabaseSchema = freshSchema;
                lastDatabaseRefresh = now;
            }

            res.json(cachedDatabaseSchema);
        } catch (error) {
            console.error('Error generating database schema:', error);

            // If we have a cached version, serve it
            if (cachedDatabaseSchema) {
                console.log('Serving cached database schema due to error');
                res.json(cachedDatabaseSchema);
            } else {
                res.status(500).json({ error: 'Failed to load database schema' });
            }
        }
    });
}

async function generateDatabaseSchema(pool) {
    const client = await pool.connect();

    try {
        // Get all tables in the public schema, excluding backup and temporary tables
        const tablesQuery = `
            SELECT 
                table_name,
                obj_description(c.oid) as table_comment
            FROM information_schema.tables t
            LEFT JOIN pg_class c ON c.relname = t.table_name
            WHERE table_schema = 'public'
            AND table_name NOT LIKE '%_bkp%'
            AND table_name NOT LIKE '%_tmp%'
            ORDER BY table_name;
        `;

        const tablesResult = await client.query(tablesQuery);

        const schema = {
            title: "Consensus Builder Database Schema",
            description: "Live database schema generated from information_schema (public schema only, excluding backup and temporary tables)",
            generated_at: new Date().toISOString(),
            database: process.env.PGDATABASE,
            schema: 'public',
            excluded_patterns: ['_bkp', '_tmp'],
            tables: {}
        };

        // For each table, get column information
        for (const table of tablesResult.rows) {
            const tableName = table.table_name;
            const tableComment = table.table_comment;

            const columnsQuery = `
                SELECT 
                    column_name,
                    data_type,
                    is_nullable,
                    column_default,
                    character_maximum_length,
                    numeric_precision,
                    numeric_scale,
                    obj_description(pgc.oid, 'pg_class') as column_comment
                FROM information_schema.columns c
                LEFT JOIN pg_class pgc ON pgc.relname = c.table_name
                WHERE table_schema = 'public' 
                AND table_name = $1
                ORDER BY ordinal_position;
            `;

            const columnsResult = await client.query(columnsQuery, [tableName]);

            // Get constraints (primary keys, foreign keys, etc.)
            const constraintsQuery = `
                SELECT 
                    tc.constraint_name,
                    tc.constraint_type,
                    kcu.column_name,
                    ccu.table_name AS foreign_table_name,
                    ccu.column_name AS foreign_column_name
                FROM information_schema.table_constraints tc
                LEFT JOIN information_schema.key_column_usage kcu
                    ON tc.constraint_name = kcu.constraint_name
                LEFT JOIN information_schema.constraint_column_usage ccu
                    ON ccu.constraint_name = tc.constraint_name
                WHERE tc.table_schema = 'public' 
                AND tc.table_name = $1
                ORDER BY tc.constraint_type, kcu.ordinal_position;
            `;

            const constraintsResult = await client.query(constraintsQuery, [tableName]);

            // Get indexes
            const indexesQuery = `
                SELECT 
                    indexname,
                    indexdef
                FROM pg_indexes 
                WHERE schemaname = 'public' 
                AND tablename = $1
                ORDER BY indexname;
            `;

            const indexesResult = await client.query(indexesQuery, [tableName]);

            schema.tables[tableName] = {
                comment: tableComment,
                columns: {},
                constraints: {},
                indexes: {}
            };

            // Process columns
            for (const column of columnsResult.rows) {
                const columnInfo = {
                    type: column.data_type,
                    nullable: column.is_nullable === 'YES',
                    default: column.column_default,
                    comment: column.column_comment
                };

                // Add type-specific information
                if (column.character_maximum_length) {
                    columnInfo.max_length = column.character_maximum_length;
                }
                if (column.numeric_precision) {
                    columnInfo.precision = column.numeric_precision;
                }
                if (column.numeric_scale) {
                    columnInfo.scale = column.numeric_scale;
                }

                schema.tables[tableName].columns[column.column_name] = columnInfo;
            }

            // Process constraints
            for (const constraint of constraintsResult.rows) {
                const constraintType = constraint.constraint_type;
                const constraintName = constraint.constraint_name;

                if (!schema.tables[tableName].constraints[constraintType]) {
                    schema.tables[tableName].constraints[constraintType] = [];
                }

                const constraintInfo = {
                    name: constraintName,
                    column: constraint.column_name
                };

                if (constraintType === 'FOREIGN KEY') {
                    constraintInfo.references = {
                        table: constraint.foreign_table_name,
                        column: constraint.foreign_column_name
                    };
                }

                schema.tables[tableName].constraints[constraintType].push(constraintInfo);
            }

            // Process indexes
            for (const index of indexesResult.rows) {
                schema.tables[tableName].indexes[index.indexname] = {
                    definition: index.indexdef
                };
            }
        }

        return schema;

    } finally {
        client.release();
    }
}
