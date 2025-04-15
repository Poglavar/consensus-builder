// Functions for analyzing road polygons


// Helper function to find line segment intersections
function findIntersections(line, polygon) {
    const intersections = [];
    const [p1, p2] = line;

    // Check intersection with each polygon segment
    for (let i = 0; i < polygon.length - 1; i++) {
        const [p3, p4] = [polygon[i], polygon[i + 1]];
        const intersection = lineIntersection(p1, p2, p3, p4);
        if (intersection) {
            intersections.push(intersection);
        }
    }

    return intersections;
}

// Helper function to find intersection of two line segments
function lineIntersection(p1, p2, p3, p4) {
    const x1 = p1[0], y1 = p1[1];
    const x2 = p2[0], y2 = p2[1];
    const x3 = p3[0], y3 = p3[1];
    const x4 = p4[0], y4 = p4[1];

    const denominator = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
    if (denominator === 0) return null;

    const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denominator;
    const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / denominator;

    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
        return [
            x1 + t * (x2 - x1),
            y1 + t * (y2 - y1)
        ];
    }

    return null;
}

// Function to check if a point is inside the polygon
function isPointInPolygon(point, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const xi = polygon[i][0], yi = polygon[i][1];
        const xj = polygon[j][0], yj = polygon[j][1];
        const intersect = ((yi > point[1]) !== (yj > point[1])) &&
            (point[0] < (xj - xi) * (point[1] - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

// Helper function to find the closest point on a line segment to a given point
function closestPointOnLineSegment(p, p1, p2) {
    const x1 = p1[0], y1 = p1[1];
    const x2 = p2[0], y2 = p2[1];
    const x = p[0], y = p[1];

    // Calculate the squared length of the line segment
    const lengthSquared = (x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1);

    // If the segment is actually a point, return the segment point
    if (lengthSquared === 0) return p1;

    // Calculate the projection of p onto the line segment
    const t = Math.max(0, Math.min(1, ((x - x1) * (x2 - x1) + (y - y1) * (y2 - y1)) / lengthSquared));

    // Calculate the closest point on the segment
    return [
        x1 + t * (x2 - x1),
        y1 + t * (y2 - y1)
    ];
}

// Function to find the main axis of the road polygon
function findMainAxis(polygon) {
    // Compute the oriented minimum bounding rectangle using convex hull
    // First, convert to a format that turf.js can work with
    const turfPoints = polygon.map(point => turf.point([point[0], point[1]]));
    const features = turf.featureCollection(turfPoints);
    const hull = turf.convex(features);

    // Calculate the minimum area rectangle
    // We'll do a simple approximation by finding the principal components
    // of the polygon vertices

    // Calculate centroid
    let centroidX = 0, centroidY = 0;
    for (const point of polygon) {
        centroidX += point[0];
        centroidY += point[1];
    }
    centroidX /= polygon.length;
    centroidY /= polygon.length;

    // Calculate covariance matrix
    let xx = 0, xy = 0, yy = 0;
    for (const point of polygon) {
        const dx = point[0] - centroidX;
        const dy = point[1] - centroidY;
        xx += dx * dx;
        xy += dx * dy;
        yy += dy * dy;
    }

    // Calculate eigenvalues and eigenvectors of covariance matrix
    const lambda1 = 0.5 * ((xx + yy) + Math.sqrt((xx - yy) * (xx - yy) + 4 * xy * xy));
    const lambda2 = 0.5 * ((xx + yy) - Math.sqrt((xx - yy) * (xx - yy) + 4 * xy * xy));

    // Major axis direction (eigenvector of largest eigenvalue)
    let majorAxisX, majorAxisY;
    if (xx - lambda1 === 0 && xy === 0) {
        majorAxisX = 1;
        majorAxisY = 0;
    } else if (xy === 0 && yy - lambda1 === 0) {
        majorAxisX = 0;
        majorAxisY = 1;
    } else {
        if (Math.abs(xx - lambda1) > Math.abs(xy)) {
            majorAxisX = -xy / (xx - lambda1);
            majorAxisY = 1;
        } else {
            majorAxisX = 1;
            majorAxisY = -(xx - lambda1) / xy;
        }

        // Normalize
        const norm = Math.sqrt(majorAxisX * majorAxisX + majorAxisY * majorAxisY);
        majorAxisX /= norm;
        majorAxisY /= norm;
    }

    return {
        centroid: [centroidX, centroidY],
        majorAxis: [majorAxisX, majorAxisY],
        minorAxis: [-majorAxisY, majorAxisX], // Perpendicular to major axis
        majorLength: Math.sqrt(lambda1),
        minorLength: Math.sqrt(lambda2)
    };
}

// Function to determine if a point is on a "long side" of the polygon
function isOnLongSide(point, polygon, axis) {
    // Find which segment of the polygon our point is on or closest to
    let minDistToSegment = Infinity;
    let closestSegmentIndex = -1;
    let closestPointOnSegment = null;

    for (let i = 0; i < polygon.length - 1; i++) {
        const [p1, p2] = [polygon[i], polygon[i + 1]];
        const pointOnSegment = closestPointOnLineSegment(point, p1, p2);
        const dx = pointOnSegment[0] - point[0];
        const dy = pointOnSegment[1] - point[1];
        const distToSegment = Math.sqrt(dx * dx + dy * dy);

        if (distToSegment < minDistToSegment) {
            minDistToSegment = distToSegment;
            closestSegmentIndex = i;
            closestPointOnSegment = pointOnSegment;
        }
    }

    if (closestSegmentIndex === -1) return false;

    // Get the segment direction
    const [p1, p2] = [polygon[closestSegmentIndex], polygon[closestSegmentIndex + 1]];
    const segDx = p2[0] - p1[0];
    const segDy = p2[1] - p1[1];
    const segLength = Math.sqrt(segDx * segDx + segDy * segDy);

    // Normalize segment direction
    const segDirX = segDx / segLength;
    const segDirY = segDy / segLength;

    // Calculate the dot product of segment direction and major axis
    const dotProduct = Math.abs(segDirX * axis.majorAxis[0] + segDirY * axis.majorAxis[1]);

    // If the dot product is close to 1, the segment is aligned with the major axis
    // If close to 0, it's aligned with the minor axis
    // We want to get width measurements only for points on segments aligned with the major axis
    return dotProduct > 0.7; // Allow some margin for imperfect alignment
}

// Find perpendicular width measurements (adjusting findOppositePoint)
function findOppositePoint(point, allPoints, polygon, boundaryLength, axis) {
    // Check if the point is on a long side
    if (!isOnLongSide(point, polygon, axis)) {
        return null; // Skip points not on the long sides
    }

    // Find which segment of the polygon our point is on or closest to
    let minDistToSegment = Infinity;
    let closestSegmentIndex = -1;
    let closestPointOnSegment = null;

    for (let i = 0; i < polygon.length - 1; i++) {
        const [p1, p2] = [polygon[i], polygon[i + 1]];
        const pointOnSegment = closestPointOnLineSegment(point, p1, p2);
        const dx = pointOnSegment[0] - point[0];
        const dy = pointOnSegment[1] - point[1];
        const distToSegment = Math.sqrt(dx * dx + dy * dy);

        if (distToSegment < minDistToSegment) {
            minDistToSegment = distToSegment;
            closestSegmentIndex = i;
            closestPointOnSegment = pointOnSegment;
        }
    }

    if (closestSegmentIndex === -1) {
        return null;
    }

    // Get the segment and calculate its direction
    const [p1, p2] = [polygon[closestSegmentIndex], polygon[closestSegmentIndex + 1]];
    const segDx = p2[0] - p1[0];
    const segDy = p2[1] - p1[1];
    const segLength = Math.sqrt(segDx * segDx + segDy * segDy);

    // Calculate normalized perpendicular direction (90 degrees to segment)
    const perpDx = -segDy / segLength;
    const perpDy = segDx / segLength;

    // Ensure the perpendicular direction is aligned with the minor axis
    // by calculating the dot product
    const dotWithMinor = perpDx * axis.minorAxis[0] + perpDy * axis.minorAxis[1];

    // Adjust the perpendicular direction if needed
    let adjustedPerpDx = perpDx;
    let adjustedPerpDy = perpDy;
    if (dotWithMinor < 0) {
        // Flip the direction
        adjustedPerpDx = -perpDx;
        adjustedPerpDy = -perpDy;
    }

    // Create a ray starting from our point or the closest point on segment if not directly on it
    const startPoint = (minDistToSegment < 0.001) ? point : closestPointOnSegment;

    // Create a search line that extends perpendicular to the boundary
    // Make it long enough to likely cross the entire polygon
    const searchDistance = boundaryLength / 2;
    const searchLine = [
        startPoint,
        [startPoint[0] + adjustedPerpDx * searchDistance, startPoint[1] + adjustedPerpDy * searchDistance]
    ];

    // Find all intersections of this perpendicular line with the polygon
    const intersections = findIntersections(searchLine, polygon);

    // Find the furthest valid intersection from our point
    let bestOpposite = null;
    let maxDist = 0;

    for (const intersection of intersections) {
        // Skip the intersection if it's too close to the original point
        // (might be the same boundary segment or very close)
        const dx = intersection[0] - startPoint[0];
        const dy = intersection[1] - startPoint[1];
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < 1) continue; // Skip if too close

        // Check if this is further than our current best
        if (dist > maxDist) {
            // Make sure the midpoint is inside the polygon
            const midpoint = [
                (startPoint[0] + intersection[0]) / 2,
                (startPoint[1] + intersection[1]) / 2
            ];

            if (isPointInPolygon(midpoint, polygon)) {
                maxDist = dist;
                bestOpposite = intersection;
            }
        }
    }

    return bestOpposite;
}

// Calculate road metrics for a polygon
function calculateRoadMetrics(coordinates) {
    // The coordinates are already in WGS84 [longitude, latitude] format
    const polygonCoords = coordinates[0];

    // Convert to HTRS96/TM for distance calculations
    const htrsPolygonCoords = polygonCoords.map(coord => {
        // Convert [lon, lat] to [easting, northing]
        return wgs84ToHTRS96(coord[1], coord[0]);
    });

    // Calculate boundary length
    let boundaryLength = 0;
    for (let i = 0; i < htrsPolygonCoords.length - 1; i++) {
        const dx = htrsPolygonCoords[i + 1][0] - htrsPolygonCoords[i][0];
        const dy = htrsPolygonCoords[i + 1][1] - htrsPolygonCoords[i][1];
        boundaryLength += Math.sqrt(dx * dx + dy * dy);
    }

    // Find the main axis of the polygon
    const mainAxis = findMainAxis(htrsPolygonCoords);

    // Sample points along the boundary
    const numSamplePoints = Math.max(50, Math.ceil(boundaryLength / 5)); // Sample every 5 meters or at least 50 points
    const samplePoints = [];
    let currentDist = 0;

    // First pass: sample points along the boundary
    for (let i = 0; i < numSamplePoints; i++) {
        const targetDist = (i / (numSamplePoints - 1)) * boundaryLength;
        currentDist = 0;

        for (let j = 0; j < htrsPolygonCoords.length - 1; j++) {
            const dx = htrsPolygonCoords[j + 1][0] - htrsPolygonCoords[j][0];
            const dy = htrsPolygonCoords[j + 1][1] - htrsPolygonCoords[j][1];
            const segmentLength = Math.sqrt(dx * dx + dy * dy);

            if (currentDist + segmentLength >= targetDist) {
                const fraction = (targetDist - currentDist) / segmentLength;
                const point = [
                    htrsPolygonCoords[j][0] + dx * fraction,
                    htrsPolygonCoords[j][1] + dy * fraction
                ];
                samplePoints.push(point);
                break;
            }
            currentDist += segmentLength;
        }
    }

    // Generate centerline points
    const centerlinePoints = [];
    const widths = [];
    const widthLines = [];

    // Count how many points we attempted to process
    let attemptedPoints = 0;

    for (const point of samplePoints) {
        attemptedPoints++;
        // Only get opposite points for points on the long sides
        const opposite = findOppositePoint(point, samplePoints, htrsPolygonCoords, boundaryLength, mainAxis);
        if (opposite) {
            const midpoint = [
                (point[0] + opposite[0]) / 2,
                (point[1] + opposite[1]) / 2
            ];

            // Calculate width
            const dx = opposite[0] - point[0];
            const dy = opposite[1] - point[1];
            const width = Math.sqrt(dx * dx + dy * dy);

            centerlinePoints.push(midpoint);
            widths.push(width);

            // Convert points to WGS84 for width lines display
            const wgs84Line = [point, opposite].map(p => {
                const [lat, lon] = htrs96ToWGS84(p[0], p[1]);
                return [lon, lat];
            });
            widthLines.push(wgs84Line);
        }
    }

    // Check if we have enough centerline points for a meaningful result
    // If we have very few points compared to attempts, try alternative approach
    if (centerlinePoints.length === 0 || (centerlinePoints.length < 3 && attemptedPoints > 10)) {
        console.warn(`Few centerline points found (${centerlinePoints.length}/${attemptedPoints}). Attempting alternative method.`);

        // Alternative: Use centroid-based approach for small/simple parcels
        try {
            // Calculate centroid
            let centroidX = 0, centroidY = 0;
            for (const coord of htrsPolygonCoords) {
                centroidX += coord[0];
                centroidY += coord[1];
            }
            centroidX /= htrsPolygonCoords.length;
            centroidY /= htrsPolygonCoords.length;

            // Find the main axis using the approach from findMainAxis
            const axis = findMainAxis(htrsPolygonCoords);

            // Create a simplified centerline using the main axis
            const centerLength = Math.min(30, axis.majorLength * 0.8); // Limit line length
            const simpleCenterline = [
                [
                    centroidX - axis.majorAxis[0] * centerLength / 2,
                    centroidY - axis.majorAxis[1] * centerLength / 2
                ],
                [centroidX, centroidY],
                [
                    centroidX + axis.majorAxis[0] * centerLength / 2,
                    centroidY + axis.majorAxis[1] * centerLength / 2
                ]
            ];

            // Convert to WGS84
            const simpleCenterlineWGS84 = simpleCenterline.map(point => {
                const [lat, lon] = htrs96ToWGS84(point[0], point[1]);
                return [lon, lat];
            });

            // Estimate width based on parcel geometry
            const estimatedWidth = axis.minorLength * 2;

            return {
                centerline: {
                    type: 'Feature',
                    properties: {},
                    geometry: {
                        type: 'LineString',
                        coordinates: simpleCenterlineWGS84
                    }
                },
                length: centerLength,
                widths: {
                    average: estimatedWidth,
                    maximum: estimatedWidth,
                    minimum: estimatedWidth,
                    tolerancePercentage: 100
                },
                widthLines: [],
                isApproximation: true
            };
        } catch (error) {
            console.error('Error in alternative centerline generation:', error);
            // Fall back to default values if the alternative approach fails
            return {
                centerline: {
                    type: 'Feature',
                    properties: {},
                    geometry: {
                        type: 'LineString',
                        coordinates: []
                    }
                },
                length: 0,
                widths: {
                    average: 0,
                    maximum: 0,
                    minimum: 0,
                    tolerancePercentage: 0
                },
                widthLines: []
            };
        }
    }

    // Center line points couldn't be found
    if (centerlinePoints.length === 0) {
        console.error('No centerline points found!');
        return {
            centerline: {
                type: 'Feature',
                properties: {},
                geometry: {
                    type: 'LineString',
                    coordinates: []
                }
            },
            length: 0,
            widths: {
                average: 0,
                maximum: 0,
                minimum: 0,
                tolerancePercentage: 0
            },
            widthLines: []
        };
    }

    // Sort centerline points to form a continuous line
    const sortedCenterline = [centerlinePoints[0]];
    const remaining = centerlinePoints.slice(1);

    while (remaining.length > 0) {
        const current = sortedCenterline[sortedCenterline.length - 1];
        let nearestIdx = 0;
        let minDist = Infinity;

        for (let i = 0; i < remaining.length; i++) {
            const dx = remaining[i][0] - current[0];
            const dy = remaining[i][1] - current[1];
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < minDist) {
                minDist = dist;
                nearestIdx = i;
            }
        }

        sortedCenterline.push(remaining[nearestIdx]);
        remaining.splice(nearestIdx, 1);
    }

    // Convert centerline to WGS84
    const centerlineWGS84 = sortedCenterline.map(point => {
        const [lat, lon] = htrs96ToWGS84(point[0], point[1]);
        return [lon, lat];
    });

    // Calculate total length along the centerline
    let length = 0;
    for (let i = 0; i < sortedCenterline.length - 1; i++) {
        const dx = sortedCenterline[i + 1][0] - sortedCenterline[i][0];
        const dy = sortedCenterline[i + 1][1] - sortedCenterline[i][1];
        length += Math.sqrt(dx * dx + dy * dy);
    }

    // Calculate width statistics
    const avgWidth = widths.reduce((a, b) => a + b, 0) / widths.length;
    const maxWidth = Math.max(...widths);
    const minWidth = Math.min(...widths);
    const withinTolerance = widths.filter(w =>
        w >= avgWidth * 0.9 && w <= avgWidth * 1.1
    ).length;
    const tolerancePercentage = (withinTolerance / widths.length) * 100;

    return {
        centerline: {
            type: 'Feature',
            properties: {},
            geometry: {
                type: 'LineString',
                coordinates: centerlineWGS84
            }
        },
        length: length,
        widths: {
            average: avgWidth,
            maximum: maxWidth,
            minimum: minWidth,
            tolerancePercentage: tolerancePercentage
        },
        widthLines: widthLines,
        mainAxis: mainAxis
    };
}

function measureAsRoad(feature) {
    const metrics = calculateRoadMetrics(feature.geometry.coordinates);
    showParcelInfoPanel(feature, metrics);
}

// Add a button to the info panel that calls the measureAsRoad function
// function addMeasureAsRoadButton() {
//     const measureAsRoadButton = `<button onclick="measureAsRoad('${feature}')">Measure as Road</button>`;
//     document.getElementById('info-content').innerHTML += measureAsRoadButton;
// }

// addMeasureAsRoadButton();
