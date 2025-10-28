// Text parsing function to analyze markdown urban rules text
function parseUrbanRuleText(text) {
    if (!text) return null;

    const lines = text.split('\n');
    const sections = [];
    const stack = []; // Stack to track current hierarchy

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmedLine = line.trim();

        if (trimmedLine.length === 0) continue;

        // Calculate indentation level (number of spaces at the beginning)
        const indentLevel = line.length - line.trimStart().length;

        // Check for section (bold text followed by colon)
        const sectionMatch = trimmedLine.match(/^\*\*(.+?):\*\*/);
        if (sectionMatch) {
            // Pop items from stack that are at the same or deeper indentation level
            while (stack.length > 0 && stack[stack.length - 1].indent >= indentLevel) {
                stack.pop();
            }

            const section = {
                name: sectionMatch[1].trim(),
                sections: [],
                paragraphs: []
            };

            // Add to appropriate parent
            if (stack.length > 0) {
                stack[stack.length - 1].item.sections.push(section);
            } else {
                sections.push(section);
            }

            // Push to stack
            stack.push({ item: section, indent: indentLevel });
            continue;
        }

        // Check for paragraph (numbered item)
        const paragraphMatch = trimmedLine.match(/^(\d+)\.\s*(.+)/);
        if (paragraphMatch) {
            const paragraphNumber = paragraphMatch[1];
            const paragraphText = paragraphMatch[2].trim();

            // Check if this is actually a section (contains bold text with colon)
            const sectionInParagraph = paragraphText.match(/\*\*(.+?):\*\*/);
            if (sectionInParagraph) {
                // This is a section, not a paragraph
                const sectionName = sectionInParagraph[1].trim();

                // Pop items from stack that are at the same or deeper indentation level
                while (stack.length > 0 && stack[stack.length - 1].indent >= indentLevel) {
                    stack.pop();
                }

                const section = {
                    name: sectionName,
                    sections: [],
                    paragraphs: []
                };

                // Add to appropriate parent
                if (stack.length > 0) {
                    stack[stack.length - 1].item.sections.push(section);
                } else {
                    sections.push(section);
                }

                // Push to stack
                stack.push({ item: section, indent: indentLevel });
                continue;
            }

            // This is a regular paragraph
            const isException = paragraphText.toLowerCase().includes('iznimno');

            const paragraph = {
                name: paragraphNumber,
                text: paragraphText,
                isException: isException
            };

            // Add to the current section (top of stack)
            if (stack.length > 0) {
                stack[stack.length - 1].item.paragraphs.push(paragraph);
            } else {
                // If no section, create a root section
                const rootSection = {
                    name: "General",
                    sections: [],
                    paragraphs: [paragraph]
                };
                sections.push(rootSection);
                stack.push({ item: rootSection, indent: 0 });
            }
            continue;
        }

    }

    return {
        sections: sections
    };
}

// GET /urban-rules?coordinates=x,y
// Get urban rules for a specific coordinate location
// Supports both WGS84 (lon,lat) and HTRS96/TM (EPSG:3765) coordinates
export function setupUrbanRulesRoute(app, pool) {
    app.get('/urban-rules', async (req, res) => {
        try {
            const coordinates = String(req.query.coordinates || '').trim();

            if (!coordinates) {
                return res.status(400).json({ error: 'Missing required parameter: coordinates' });
            }

            // Parse coordinates
            const parts = coordinates.split(',').map(n => Number(n));
            if (parts.length !== 2 || parts.some(v => !isFinite(v))) {
                return res.status(400).json({ error: 'Invalid coordinates. Expected x,y format.' });
            }
            const [x, y] = parts;

            // Detect coordinate system based on value ranges
            // WGS84: longitude -180 to 180, latitude -90 to 90
            // EPSG:3765 (HTRS96/TM): x ~400000-800000, y ~4000000-5000000
            const isWGS84 = (x >= -180 && x <= 180 && y >= -90 && y <= 90);
            const isHTRS96 = (x >= 300000 && x <= 900000 && y >= 4000000 && y <= 5500000);

            if (!isWGS84 && !isHTRS96) {
                return res.status(400).json({
                    error: 'Invalid coordinate range. Expected WGS84 (lon,lat) or HTRS96/TM (x,y) coordinates.'
                });
            }

            let sql, params;

            if (isWGS84) {
                // Transform from WGS84 (EPSG:4326) to HTRS96/TM (EPSG:3765)
                sql = `
                    SELECT 
                        ur.geom_hash,
                        ur.geom,
                        ur.title,
                        ur.short_name,
                        ur.exception_from,
                        ur.exception_para,
                        ur.created_at,
                        ur.updated_at,
                        ur.updated_by,
                        urt.paragraph,
                        urt.text,
                        urt.updated_at as text_updated_at,
                        urt.updated_by as text_updated_by,
                        urv.rule_id,
                        urv.rule_short_name as var_rule_short_name,
                        urv.land_uses_text,
                        urv.land_uses_marks,
                        urv.exception_paragraph,
                        urv.variables
                    FROM urban_rule ur
                    LEFT JOIN urban_rule_text urt ON ur.short_name = urt.rule_short_name
                    LEFT JOIN urban_rule_variable urv ON ur.short_name = urv.rule_short_name 
                        AND (ur.exception_para = urv.exception_paragraph OR (ur.exception_para IS NULL AND urv.exception_paragraph IS NULL))
                    WHERE ST_Contains(ur.geom, ST_Transform(ST_SetSRID(ST_MakePoint($1, $2), 4326), 3765))
                    ORDER BY ur.title
                `;
            } else {
                // Use coordinates as-is (already in EPSG:3765)
                sql = `
                    SELECT 
                        ur.geom_hash,
                        ur.geom,
                        ur.title,
                        ur.short_name,
                        ur.exception_from,
                        ur.exception_para,
                        ur.created_at,
                        ur.updated_at,
                        ur.updated_by,
                        urt.paragraph,
                        urt.text,
                        urt.updated_at as text_updated_at,
                        urt.updated_by as text_updated_by,
                        urv.rule_id,
                        urv.rule_short_name as var_rule_short_name,
                        urv.land_uses_text,
                        urv.land_uses_marks,
                        urv.exception_paragraph,
                        urv.variables
                    FROM urban_rule ur
                    LEFT JOIN urban_rule_text urt ON ur.short_name = urt.rule_short_name
                    LEFT JOIN urban_rule_variable urv ON ur.short_name = urv.rule_short_name 
                        AND (ur.exception_para = urv.exception_paragraph OR (ur.exception_para IS NULL AND urv.exception_paragraph IS NULL))
                    WHERE ST_Contains(ur.geom, ST_SetSRID(ST_MakePoint($1, $2), 3765))
                    ORDER BY ur.title
                `;
            }
            params = [x, y];

            const { rows } = await pool.query(sql, params);

            // Check the number of unique urban rules (not text entries)
            const uniqueRules = new Set(rows.map(row => row.title));
            const ruleCount = uniqueRules.size;

            if (ruleCount === 0) {
                return res.status(404).json({ error: 'No urban rules found for the given coordinates.' });
            }

            if (ruleCount > 2) {
                return res.status(400).json({
                    error: 'Too many urban rules found for the given coordinates.',
                    count: ruleCount,
                    message: 'Expected 1-2 urban rules, but found ' + ruleCount + '.'
                });
            }

            // Group results by urban rule title
            const rulesMap = new Map();
            rows.forEach(row => {
                if (!rulesMap.has(row.title)) {
                    const rule = {
                        geom_hash: row.geom_hash,
                        title: row.title,
                        short_name: row.short_name,
                        exception_from: row.exception_from,
                        exception_para: row.exception_para,
                        created_at: row.created_at,
                        updated_at: row.updated_at,
                        updated_by: row.updated_by,
                        text_entry: null
                    };

                    // Add urban rule variable data if it exists
                    if (row.rule_id) {
                        rule.rule_variable = {
                            rule_id: row.rule_id,
                            rule_short_name: row.var_rule_short_name,
                            land_uses_text: row.land_uses_text,
                            land_uses_marks: row.land_uses_marks,
                            exception_paragraph: row.exception_paragraph,
                            variables: row.variables
                        };
                    }

                    rulesMap.set(row.title, rule);
                }

                // Set text entry if it exists (only one per rule)
                if ((row.paragraph || row.text) && !rulesMap.get(row.title).text_entry) {
                    const textEntry = {
                        paragraph: row.paragraph,
                        text: row.text,
                        updated_at: row.text_updated_at,
                        updated_by: row.text_updated_by
                    };

                    // Add analyzed-formatted version of the text
                    if (row.text) {
                        textEntry.analyzed_formatted = parseUrbanRuleText(row.text);
                    }

                    rulesMap.get(row.title).text_entry = textEntry;
                }
            });

            // Apply filtering logic for text entries
            rulesMap.forEach((rule, title) => {
                if (title !== 'IZNIMKA' && rule.text_entry) {
                    // For non-IZNIMKA rules: filter out paragraphs starting with 'IZNIMKA'
                    if (rule.text_entry.text && rule.text_entry.text.includes('IZNIMKA')) {
                        rule.text_entry = null;
                    }
                }
            });

            // Convert to array
            const rules = Array.from(rulesMap.values());

            // Return all rules
            res.json({
                coordinates: { x, y },
                coordinate_system: isWGS84 ? 'WGS84' : 'HTRS96/TM',
                rule_count: ruleCount,
                urban_rules: rules
            });

        } catch (err) {
            console.error('Error in /urban-rules:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });
}
