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

// New improved road width analysis functions

/**
 * Analyze a road parcel to determine its roadlike segments and widths
 * Uses skeletonization and statistical width analysis instead of polygon splitting
 * @param {Array} coordinates - Road polygon coordinates
 * @returns {Object} Metrics including centerline, segments, and width statistics
 */
function analyzeRoadWidth(coordinates) {
    // Get first ring of coordinates if in nested format
    const polygonCoords = coordinates[0];

    console.log("Road Analysis: Input polygon coordinates:", polygonCoords.length, "points");

    // Convert to HTRS96/TM for distance calculations
    const htrsPolygonCoords = polygonCoords.map(coord => {
        // Convert [lon, lat] to [easting, northing]
        return wgs84ToHTRS96(coord[1], coord[0]);
    });

    console.log("Road Analysis: Converted to HTRS coords");

    // 1. Generate the skeleton/medial axis
    const skeleton = generateSkeleton(htrsPolygonCoords);
    console.log("Road Analysis: Generated skeleton with", skeleton.points?.length || 0, "points");

    // 2. Identify segments in the skeleton
    const segments = identifySegments(skeleton, htrsPolygonCoords);
    console.log("Road Analysis: Identified", segments.length, "segments");

    // 3. Sample width measurements along each segment
    const segmentMeasurements = segments.map(segment => {
        const measurements = measureSegmentWidths(segment, htrsPolygonCoords);
        console.log("Road Analysis: Segment width measurements:", measurements.widths?.length || 0, "measurements");
        return measurements;
    });

    // 4. Filter outliers and calculate average width for each segment
    const filteredMeasurements = segmentMeasurements.map(measurements => {
        const filtered = filterWidthOutliers(measurements);
        console.log("Road Analysis: Filtered widths:", filtered.filteredWidths?.length || 0, "measurements after filtering");
        return filtered;
    });

    // 5. Format results for display
    console.log("Road Analysis: Formatting road analysis results");
    const result = formatRoadAnalysisResults(segments, filteredMeasurements, polygonCoords);
    console.log("Road Analysis: Final results:", result);

    return result;
}

/**
 * Generate a skeleton (medial axis) for the road polygon
 * @param {Array} polygon - Road polygon coordinates in HTRS96
 * @returns {Array} Skeleton points and connections
 */
function generateSkeleton(polygon) {
    // Simplified implementation using Turf.js
    // First, convert the polygon to a proper GeoJSON polygon
    const turfPolygon = {
        type: 'Feature',
        properties: {},
        geometry: {
            type: 'Polygon',
            coordinates: [polygon]
        }
    };

    try {
        // Try to use Turf's medial axis if available
        if (turf.medial) {
            return turf.medial(turfPolygon);
        }
    } catch (e) {
        console.log('Turf medial axis not available, using simplified approach');
    }

    // Simplified skeleton approach if Turf's medial axis isn't available
    // We'll use the main axis of the polygon as a simplified skeleton
    const axis = findMainAxis(polygon);

    // Generate points along the main axis
    const numPoints = 20;
    const centerLine = [];

    for (let i = 0; i < numPoints; i++) {
        const t = (i / (numPoints - 1)) * 2 - 1; // -1 to 1
        const point = [
            axis.centroid[0] + axis.majorAxis[0] * axis.majorLength * t * 0.5,
            axis.centroid[1] + axis.majorAxis[1] * axis.majorLength * t * 0.5
        ];

        // Only add points inside the polygon
        if (isPointInPolygon(point, polygon)) {
            centerLine.push(point);
        }
    }

    // Return a simple skeleton with one segment
    return {
        points: centerLine,
        segments: [{ points: centerLine }]
    };
}

/**
 * Identify logical segments in the skeleton
 * @param {Object} skeleton - The road skeleton
 * @param {Array} polygon - Road polygon coordinates
 * @returns {Array} Array of segments
 */
function identifySegments(skeleton, polygon) {
    // In our simplified approach, we'll return the skeleton's segments directly
    // If we're using the main axis approach, we'll have one segment
    if (skeleton.segments) {
        return skeleton.segments;
    }

    // If we're working with just points, make them a single segment
    return [{ points: skeleton.points || skeleton }];
}

/**
 * Measure road widths along a segment
 * @param {Object} segment - Segment from the skeleton
 * @param {Array} polygon - Road polygon coordinates
 * @returns {Object} Width measurements along the segment
 */
function measureSegmentWidths(segment, polygon) {
    const points = segment.points;
    const widths = [];
    const positions = [];
    const widthLines = [];

    // Sample widths at regular intervals along the segment
    for (let i = 0; i < points.length; i++) {
        const point = points[i];

        // For each point, we need to find the direction perpendicular to the segment
        let perpVector;

        if (i === 0) {
            // First point - use direction to next point
            const nextPoint = points[i + 1];
            const dirX = nextPoint[0] - point[0];
            const dirY = nextPoint[1] - point[1];
            const length = Math.sqrt(dirX * dirX + dirY * dirY);

            // Perpendicular vector (rotate 90 degrees)
            perpVector = [-dirY / length, dirX / length];
        } else if (i === points.length - 1) {
            // Last point - use direction from previous point
            const prevPoint = points[i - 1];
            const dirX = point[0] - prevPoint[0];
            const dirY = point[1] - prevPoint[1];
            const length = Math.sqrt(dirX * dirX + dirY * dirY);

            // Perpendicular vector (rotate 90 degrees)
            perpVector = [-dirY / length, dirX / length];
        } else {
            // Middle point - use average direction
            const prevPoint = points[i - 1];
            const nextPoint = points[i + 1];

            const dir1X = point[0] - prevPoint[0];
            const dir1Y = point[1] - prevPoint[1];
            const length1 = Math.sqrt(dir1X * dir1X + dir1Y * dir1Y);

            const dir2X = nextPoint[0] - point[0];
            const dir2Y = nextPoint[1] - point[1];
            const length2 = Math.sqrt(dir2X * dir2X + dir2Y * dir2Y);

            // Average direction (normalized)
            const avgDirX = (dir1X / length1 + dir2X / length2) / 2;
            const avgDirY = (dir1Y / length1 + dir2Y / length2) / 2;
            const avgLength = Math.sqrt(avgDirX * avgDirX + avgDirY * avgDirY);

            // Perpendicular vector (rotate 90 degrees)
            perpVector = [-avgDirY / avgLength, avgDirX / avgLength];
        }

        // Create a search line perpendicular to the direction
        const maxSearchDistance = 100; // meters
        const searchLine = [
            [point[0] - perpVector[0] * maxSearchDistance, point[1] - perpVector[1] * maxSearchDistance],
            [point[0] + perpVector[0] * maxSearchDistance, point[1] + perpVector[1] * maxSearchDistance]
        ];

        // Find intersections with the polygon
        const intersections = findIntersections(searchLine, polygon);

        if (intersections.length >= 2) {
            // Find the two intersections furthest apart
            let maxDistance = 0;
            let furthestPair = null;

            for (let j = 0; j < intersections.length; j++) {
                for (let k = j + 1; k < intersections.length; k++) {
                    const dx = intersections[j][0] - intersections[k][0];
                    const dy = intersections[j][1] - intersections[k][1];
                    const distance = Math.sqrt(dx * dx + dy * dy);

                    // Check if the midpoint is inside the polygon
                    const midpoint = [
                        (intersections[j][0] + intersections[k][0]) / 2,
                        (intersections[j][1] + intersections[k][1]) / 2
                    ];

                    if (distance > maxDistance && isPointInPolygon(midpoint, polygon)) {
                        maxDistance = distance;
                        furthestPair = [intersections[j], intersections[k]];
                    }
                }
            }

            if (furthestPair) {
                // Record width and position
                widths.push(maxDistance);
                positions.push(i / (points.length - 1)); // Normalized position (0-1) along segment

                // Save width line for visualization (converted to WGS84)
                const wgs84Line = furthestPair.map(p => {
                    const [lat, lon] = htrs96ToWGS84(p[0], p[1]);
                    return [lon, lat];
                });
                widthLines.push(wgs84Line);
            }
        }
    }

    return {
        widths,
        positions,
        widthLines,
        segment: points.map(p => {
            const [lat, lon] = htrs96ToWGS84(p[0], p[1]);
            return [lon, lat];
        })
    };
}

/**
 * Filter outliers from width measurements using IQR method
 * @param {Object} measurements - Width measurements along a segment
 * @returns {Object} Filtered measurements and statistics
 */
function filterWidthOutliers(measurements) {
    const { widths, positions, widthLines, segment } = measurements;

    if (widths.length < 3) {
        // Not enough data points for outlier detection
        return {
            widths,
            positions,
            widthLines,
            segment,
            avgWidth: widths.length > 0 ?
                widths.reduce((sum, width) => sum + width, 0) / widths.length : 0,
            minWidth: widths.length > 0 ? Math.min(...widths) : 0,
            maxWidth: widths.length > 0 ? Math.max(...widths) : 0,
            filteredWidths: widths,
            filteredPositions: positions,
            filteredWidthLines: widthLines,
            outlierPercentage: 0
        };
    }

    // Sort widths for quartile calculation
    const sortedWidths = [...widths].sort((a, b) => a - b);

    // Calculate quartiles
    const q1Index = Math.floor(sortedWidths.length * 0.25);
    const q3Index = Math.floor(sortedWidths.length * 0.75);
    const q1 = sortedWidths[q1Index];
    const q3 = sortedWidths[q3Index];
    const iqr = q3 - q1;

    // Define outlier thresholds
    const lowerThreshold = q1 - 1.5 * iqr;
    const upperThreshold = q3 + 1.5 * iqr;

    // Filter out outliers
    const filteredIndices = [];
    const filteredWidths = [];
    const filteredPositions = [];
    const filteredWidthLines = [];

    widths.forEach((width, index) => {
        if (width >= lowerThreshold && width <= upperThreshold) {
            filteredIndices.push(index);
            filteredWidths.push(width);
            filteredPositions.push(positions[index]);
            filteredWidthLines.push(widthLines[index]);
        }
    });

    // Calculate statistics
    const avgWidth = filteredWidths.length > 0 ?
        filteredWidths.reduce((sum, width) => sum + width, 0) / filteredWidths.length : 0;
    const minWidth = filteredWidths.length > 0 ? Math.min(...filteredWidths) : 0;
    const maxWidth = filteredWidths.length > 0 ? Math.max(...filteredWidths) : 0;
    const outlierPercentage = ((widths.length - filteredWidths.length) / widths.length) * 100;

    return {
        widths,
        positions,
        widthLines,
        segment,
        avgWidth,
        minWidth,
        maxWidth,
        filteredWidths,
        filteredPositions,
        filteredWidthLines,
        outlierPercentage
    };
}

/**
 * Format road analysis results for display
 * @param {Array} segments - Road segments
 * @param {Array} measurements - Width measurements for each segment
 * @param {Array} originalCoords - Original road polygon coordinates (WGS84)
 * @returns {Object} Formatted results
 */
function formatRoadAnalysisResults(segments, measurements, originalCoords) {
    console.log("Road Analysis: formatRoadAnalysisResults called with",
        segments.length, "segments,",
        measurements.length, "measurements",
        "and", originalCoords.length, "original coordinates");

    // Calculate overall statistics
    let totalLength = 0;
    let weightedWidthSum = 0;
    let allWidthLines = [];

    // Centerline features for all segments
    const centerlineCoordinates = [];

    measurements.forEach((measurement, idx) => {
        // Skip segments with no valid measurements
        if (!measurement.filteredWidths || measurement.filteredWidths.length === 0) {
            console.log(`Road Analysis: Skipping segment ${idx} - no filtered widths`);
            return;
        }

        // Add segment to centerline
        if (measurement.segment && Array.isArray(measurement.segment) && measurement.segment.length > 0) {
            console.log(`Road Analysis: Adding segment ${idx} to centerline with ${measurement.segment.length} points`);
            centerlineCoordinates.push(...measurement.segment);
        } else {
            console.log(`Road Analysis: Segment ${idx} has no valid centerline points`);
        }

        // Calculate segment length
        let segmentLength = 0;
        if (segments[idx] && segments[idx].points && segments[idx].points.length > 1) {
            const segmentPoints = segments[idx].points;

            for (let i = 0; i < segmentPoints.length - 1; i++) {
                const dx = segmentPoints[i + 1][0] - segmentPoints[i][0];
                const dy = segmentPoints[i + 1][1] - segmentPoints[i][1];
                segmentLength += Math.sqrt(dx * dx + dy * dy);
            }
        }

        // Add to total
        totalLength += segmentLength;
        weightedWidthSum += measurement.avgWidth * segmentLength;

        // Add width lines
        if (measurement.filteredWidthLines && Array.isArray(measurement.filteredWidthLines)) {
            allWidthLines.push(...measurement.filteredWidthLines);
        }
    });

    // Calculate weighted average width
    const overallAvgWidth = totalLength > 0 ? weightedWidthSum / totalLength : 0;

    // Get min/max width across all filtered measurements
    let minWidth = Infinity;
    let maxWidth = 0;

    measurements.forEach(measurement => {
        if (measurement.filteredWidths && measurement.filteredWidths.length > 0) {
            minWidth = Math.min(minWidth, measurement.minWidth);
            maxWidth = Math.max(maxWidth, measurement.maxWidth);
        }
    });

    // If no valid measurements were found
    if (minWidth === Infinity) {
        minWidth = 0;
    }

    // Calculate percentage of widths within tolerance of the average
    let widthsWithinTolerance = 0;
    let totalFilteredWidths = 0;

    measurements.forEach(measurement => {
        if (measurement.filteredWidths && Array.isArray(measurement.filteredWidths)) {
            measurement.filteredWidths.forEach(width => {
                if (width >= overallAvgWidth * 0.9 && width <= overallAvgWidth * 1.1) {
                    widthsWithinTolerance++;
                }
                totalFilteredWidths++;
            });
        }
    });

    const tolerancePercentage = totalFilteredWidths > 0 ?
        (widthsWithinTolerance / totalFilteredWidths) * 100 : 0;

    // Create centerline GeoJSON if we have coordinates
    let centerlineFeature;
    if (centerlineCoordinates.length >= 2) {
        console.log(`Road Analysis: Creating centerline with ${centerlineCoordinates.length} points`);

        // Sort centerline points to make sure they form a continuous line
        const sortedCoordinates = sortCenterlinePoints(centerlineCoordinates);

        centerlineFeature = {
            type: 'Feature',
            properties: {},
            geometry: {
                type: 'LineString',
                coordinates: sortedCoordinates
            }
        };
    } else {
        console.warn("Road Analysis: Not enough points to create a valid centerline");

        // Create a fallback centerline using the polygon's center
        // This is just so we have something to display
        const centroid = calculateCentroid(originalCoords);
        const fallbackLine = [
            [centroid[0] - 0.0001, centroid[1] - 0.0001],
            [centroid[0] + 0.0001, centroid[1] + 0.0001]
        ];

        centerlineFeature = {
            type: 'Feature',
            properties: { isFallback: true },
            geometry: {
                type: 'LineString',
                coordinates: fallbackLine
            }
        };
    }

    // Collect segment information
    const segmentInfo = [];
    for (let i = 0; i < measurements.length; i++) {
        const m = measurements[i];
        if (m && m.segment && m.filteredWidths) {
            segmentInfo.push({
                centerline: m.segment,
                widths: m.filteredWidths,
                avgWidth: m.avgWidth || 0
            });
        }
    }

    return {
        centerline: centerlineFeature,
        length: totalLength,
        widths: {
            average: overallAvgWidth,
            maximum: maxWidth,
            minimum: minWidth,
            tolerancePercentage: tolerancePercentage
        },
        widthLines: allWidthLines,
        segments: segmentInfo
    };
}

// Helper function to sort centerline points into a continuous line
function sortCenterlinePoints(points) {
    if (points.length <= 2) return points;

    const sorted = [points[0]];
    const remaining = points.slice(1);

    while (remaining.length > 0) {
        const current = sorted[sorted.length - 1];
        let nearestIdx = 0;
        let minDist = distanceBetweenPoints(current, remaining[0]);

        for (let i = 1; i < remaining.length; i++) {
            const dist = distanceBetweenPoints(current, remaining[i]);
            if (dist < minDist) {
                minDist = dist;
                nearestIdx = i;
            }
        }

        sorted.push(remaining[nearestIdx]);
        remaining.splice(nearestIdx, 1);
    }

    return sorted;
}

// Helper function to calculate distance between two points
function distanceBetweenPoints(p1, p2) {
    const dx = p2[0] - p1[0];
    const dy = p2[1] - p1[1];
    return Math.sqrt(dx * dx + dy * dy);
}

// Helper function to calculate centroid of a polygon
function calculateCentroid(coords) {
    let sumX = 0;
    let sumY = 0;

    for (const coord of coords) {
        sumX += coord[0];
        sumY += coord[1];
    }

    return [sumX / coords.length, sumY / coords.length];
}

// Replace the problematic calculateRoadMetrics function with our new implementation
function calculateRoadMetrics(coordinates) {
    try {
        return analyzeRoadWidth(coordinates);
    } catch (error) {
        console.error('Error in road width analysis:', error);

        // Fallback to a very simplified approach if analysis fails
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

// Replace the problematic splitRoadParcel function with a safer implementation
function splitRoadParcel(feature) {
    try {
        // Analyze the road to identify segments
        const metrics = analyzeRoadWidth(feature.geometry.coordinates);

        // If we don't have multiple segments or the analysis failed, return the original
        if (!metrics.segments || metrics.segments.length <= 1) {
            return [feature];
        }

        // Create a separate feature for each significant segment
        const parentId = feature.properties.CESTICA_ID;
        const splitFeatures = [];

        // Only create split features for segments with reasonable data
        metrics.segments.forEach((segment, index) => {
            // Skip segments with no width data or very small segments
            if (!segment.centerline || segment.centerline.length < 3 || !segment.avgWidth) {
                return;
            }

            // Convert segment centerline to a polygon by buffering
            const halfWidth = segment.avgWidth / 2;
            const segmentPolygon = createPolygonFromCenterline(segment.centerline, halfWidth);

            // Create a new feature for this segment
            splitFeatures.push({
                type: 'Feature',
                properties: {
                    ...feature.properties,
                    CESTICA_ID: `${parentId}_split_${index + 1}`,
                    parentId: parentId,
                    calculatedArea: calculateArea([segmentPolygon])
                },
                geometry: {
                    type: 'Polygon',
                    coordinates: [segmentPolygon]
                }
            });
        });

        // If we successfully created split features, return them
        if (splitFeatures.length > 0) {
            return splitFeatures;
        }

        // Fallback to original feature if splitting failed
        return [feature];
    } catch (error) {
        console.error('Error in splitRoadParcel:', error);
        // Return the original feature if splitting fails
        return [feature];
    }
}

// Helper function to create a polygon from a centerline by buffering
function createPolygonFromCenterline(centerline, halfWidth) {
    // Simplified implementation - create a rectangle for each line segment
    // and dissolve them together
    if (centerline.length < 2) {
        return centerline;
    }

    try {
        // Try to use Turf.js buffer if available
        const line = {
            type: 'Feature',
            properties: {},
            geometry: {
                type: 'LineString',
                coordinates: centerline
            }
        };

        if (turf.buffer) {
            const buffered = turf.buffer(line, halfWidth, { units: 'meters' });
            return buffered.geometry.coordinates[0];
        }
    } catch (e) {
        console.log('Turf buffer not available, using simplified approach');
    }

    // Simple fallback implementation - create a very simplified buffer
    // by extending perpendicular to each segment
    const polygon = [];

    // First side (left)
    for (let i = 0; i < centerline.length; i++) {
        const point = centerline[i];
        let perpVector;

        if (i === 0) {
            // First point
            const nextPoint = centerline[i + 1];
            const dx = nextPoint[0] - point[0];
            const dy = nextPoint[1] - point[1];
            const length = Math.sqrt(dx * dx + dy * dy);
            perpVector = [-dy / length, dx / length];
        } else if (i === centerline.length - 1) {
            // Last point
            const prevPoint = centerline[i - 1];
            const dx = point[0] - prevPoint[0];
            const dy = point[1] - prevPoint[1];
            const length = Math.sqrt(dx * dx + dy * dy);
            perpVector = [-dy / length, dx / length];
        } else {
            // Middle point
            const prevPoint = centerline[i - 1];
            const nextPoint = centerline[i + 1];

            const dx1 = point[0] - prevPoint[0];
            const dy1 = point[1] - prevPoint[1];
            const length1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);

            const dx2 = nextPoint[0] - point[0];
            const dy2 = nextPoint[1] - point[1];
            const length2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);

            const perpX1 = -dy1 / length1;
            const perpY1 = dx1 / length1;

            const perpX2 = -dy2 / length2;
            const perpY2 = dx2 / length2;

            // Average the perpendicular vectors
            perpVector = [
                (perpX1 + perpX2) / 2,
                (perpY1 + perpY2) / 2
            ];

            // Normalize
            const perpLength = Math.sqrt(perpVector[0] * perpVector[0] + perpVector[1] * perpVector[1]);
            perpVector[0] /= perpLength;
            perpVector[1] /= perpLength;
        }

        // Add point offset by perpendicular vector * halfWidth
        polygon.push([
            point[0] + perpVector[0] * halfWidth,
            point[1] + perpVector[1] * halfWidth
        ]);
    }

    // Second side (right) - go backwards
    for (let i = centerline.length - 1; i >= 0; i--) {
        const point = centerline[i];
        let perpVector;

        if (i === centerline.length - 1) {
            // Last point
            const prevPoint = centerline[i - 1];
            const dx = point[0] - prevPoint[0];
            const dy = point[1] - prevPoint[1];
            const length = Math.sqrt(dx * dx + dy * dy);
            perpVector = [-dy / length, dx / length];
        } else if (i === 0) {
            // First point
            const nextPoint = centerline[i + 1];
            const dx = nextPoint[0] - point[0];
            const dy = nextPoint[1] - point[1];
            const length = Math.sqrt(dx * dx + dy * dy);
            perpVector = [-dy / length, dx / length];
        } else {
            // Middle point
            const prevPoint = centerline[i - 1];
            const nextPoint = centerline[i + 1];

            const dx1 = point[0] - prevPoint[0];
            const dy1 = point[1] - prevPoint[1];
            const length1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);

            const dx2 = nextPoint[0] - point[0];
            const dy2 = nextPoint[1] - point[1];
            const length2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);

            const perpX1 = -dy1 / length1;
            const perpY1 = dx1 / length1;

            const perpX2 = -dy2 / length2;
            const perpY2 = dx2 / length2;

            // Average the perpendicular vectors
            perpVector = [
                (perpX1 + perpX2) / 2,
                (perpY1 + perpY2) / 2
            ];

            // Normalize
            const perpLength = Math.sqrt(perpVector[0] * perpVector[0] + perpVector[1] * perpVector[1]);
            perpVector[0] /= perpLength;
            perpVector[1] /= perpLength;
        }

        // Add point offset by negative perpendicular vector * halfWidth
        polygon.push([
            point[0] - perpVector[0] * halfWidth,
            point[1] - perpVector[1] * halfWidth
        ]);
    }

    // Close the polygon
    if (polygon.length > 0) {
        polygon.push([...polygon[0]]);
    }

    return polygon;
}

// Add a button to the info panel that calls the measureAsRoad function
// function addMeasureAsRoadButton() {
//     const measureAsRoadButton = `<button onclick="measureAsRoad('${feature}')">Measure as Road</button>`;
//     document.getElementById('info-content').innerHTML += measureAsRoadButton;
// }

// addMeasureAsRoadButton();

// Create variables to store the road analysis layers
let roadAnalysisLayers = {
    centerline: null,
    widthLines: [],
    outlierLines: [],
    segments: [],
    segmentLabels: []
};

// Current road analysis data
let currentRoadAnalysis = null;

// Show the Road Analysis panel with data from the current parcel
function showRoadAnalysisPanel() {
    console.log("Road Analysis: Starting analysis for parcel", currentParcel);

    // Make sure we have a current parcel selected and it's marked as a road
    if (!currentParcel || !currentParcel.layer || !currentParcel.layer.feature) {
        alert('Please select a road parcel first');
        return;
    }

    // Mark as a road if not already marked
    if (!currentParcel.isRoad) {
        document.getElementById('roadCheckbox').checked = true;
        currentParcel.isRoad = true;
        currentParcel.layer.setStyle(roadStyle);
        localStorage.setItem(`parcel_${currentParcel.id}_isRoad`, 'true');
    }

    const feature = currentParcel.layer.feature;
    console.log("Road Analysis: Parcel feature", feature);

    // Validate feature geometry
    if (!feature.geometry || !feature.geometry.coordinates ||
        !feature.geometry.coordinates[0] || feature.geometry.coordinates[0].length < 3) {
        alert('This parcel has invalid geometry and cannot be analyzed');
        return;
    }

    // Display the panel before running the analysis to show it's working
    document.getElementById('road-analysis-panel').classList.add('visible');

    // Clear any previous analysis visualization
    clearRoadAnalysisVisualization();

    // Reset the panel
    document.getElementById('analysis-avg-width').innerHTML = 'Analyzing...';
    document.getElementById('analysis-road-length').innerHTML = '...';
    document.getElementById('analysis-width-range').innerHTML = '...';
    document.getElementById('analysis-width-consistency').innerHTML = '...';
    document.getElementById('analysis-segments-count').innerHTML = '...';
    document.getElementById('analysis-outliers').innerHTML = '...';
    document.getElementById('segments-list').innerHTML = '<p>Analyzing segments...</p>';

    // Switch to the overview tab
    const overviewTab = document.querySelector('.tab-btn[onclick="switchTab(this, \'overview-tab\')"]');
    if (overviewTab) {
        switchTab(overviewTab, 'overview-tab');
    }

    // Run the road width analysis as a setTimeout to allow the UI to update
    setTimeout(() => {
        try {
            console.log("Road Analysis: Analyzing road width for coordinates", feature.geometry.coordinates);

            // Analyze the road
            const metrics = analyzeRoadWidth(feature.geometry.coordinates);
            console.log("Road Analysis: Analysis complete, metrics =", metrics);

            // Check if analysis returned valid results
            if (!metrics || !metrics.centerline || !metrics.centerline.geometry ||
                !metrics.centerline.geometry.coordinates || metrics.centerline.geometry.coordinates.length === 0) {

                console.warn("Road Analysis: Invalid metrics returned - no valid centerline");
                document.getElementById('analysis-avg-width').innerHTML = 'Analysis failed - no valid centerline found';
                document.getElementById('segments-list').innerHTML = '<p>No segments could be identified.</p>';
                return;
            }

            currentRoadAnalysis = metrics;

            // Update the panel with the results
            console.log("Road Analysis: Updating panel with metrics");
            updateRoadAnalysisPanel(metrics);

            // Draw the visualization
            console.log("Road Analysis: Visualizing analysis");
            visualizeRoadAnalysis(metrics);

        } catch (error) {
            console.error('Error in road analysis:', error);
            document.getElementById('analysis-avg-width').innerHTML = 'Error analyzing road';
            document.getElementById('segments-list').innerHTML = '<p>Error analyzing segments: ' + (error.message || 'Unknown error') + '</p>';

            // Still try to focus on the parcel even if analysis failed
            focusOnCurrentParcel();
        }
    }, 10); // tiny delay to let UI update
}

// Hide the Road Analysis panel
function hideRoadAnalysisPanel() {
    document.getElementById('road-analysis-panel').classList.remove('visible');
    clearRoadAnalysisVisualization();
}

// Clear all road analysis visualization layers
function clearRoadAnalysisVisualization() {
    // Remove centerline
    if (roadAnalysisLayers.centerline) {
        map.removeLayer(roadAnalysisLayers.centerline);
        roadAnalysisLayers.centerline = null;
    }

    // Remove width lines
    roadAnalysisLayers.widthLines.forEach(line => {
        if (line) map.removeLayer(line);
    });
    roadAnalysisLayers.widthLines = [];

    // Remove outlier lines
    roadAnalysisLayers.outlierLines.forEach(line => {
        if (line) map.removeLayer(line);
    });
    roadAnalysisLayers.outlierLines = [];

    // Remove segment markers
    roadAnalysisLayers.segments.forEach(segment => {
        if (segment) map.removeLayer(segment);
    });
    roadAnalysisLayers.segments = [];

    // Remove segment labels
    roadAnalysisLayers.segmentLabels.forEach(label => {
        if (label) map.removeLayer(label);
    });
    roadAnalysisLayers.segmentLabels = [];
}

// Update the Road Analysis panel with the analysis results
function updateRoadAnalysisPanel(metrics) {
    // Validate metrics object
    if (!metrics) {
        console.error('Invalid metrics provided to updateRoadAnalysisPanel');
        document.getElementById('analysis-avg-width').innerHTML = 'Invalid metrics data';
        return;
    }

    try {
        // Update the overview tab with safe defaults
        const formattedLength = formatNumber(metrics.length || 0);
        const formattedAvgWidth = formatNumber(metrics.widths?.average || 0);
        const formattedMinWidth = formatNumber(metrics.widths?.minimum || 0);
        const formattedMaxWidth = formatNumber(metrics.widths?.maximum || 0);
        const formattedConsistency = formatNumber(metrics.widths?.tolerancePercentage || 0);

        document.getElementById('analysis-road-length').innerHTML = `${formattedLength} m`;
        document.getElementById('analysis-avg-width').innerHTML = `${formattedAvgWidth} m`;
        document.getElementById('analysis-width-range').innerHTML = `${formattedMinWidth} - ${formattedMaxWidth} m`;
        document.getElementById('analysis-width-consistency').innerHTML = `${formattedConsistency}%`;
        document.getElementById('analysis-segments-count').innerHTML = metrics.segments?.length || 0;

        // Calculate overall outliers
        let totalWidthMeasurements = 0;
        let filteredWidthMeasurements = 0;

        if (metrics.segments && Array.isArray(metrics.segments)) {
            metrics.segments.forEach(segment => {
                if (segment?.widths && Array.isArray(segment.widths)) {
                    totalWidthMeasurements += segment.widths.length;
                }
                if (segment?.filteredWidths && Array.isArray(segment.filteredWidths)) {
                    filteredWidthMeasurements += segment.filteredWidths.length;
                }
            });
        }

        const outlierPercentage = totalWidthMeasurements > 0 ?
            formatNumber(((totalWidthMeasurements - filteredWidthMeasurements) / totalWidthMeasurements) * 100) : '0';

        document.getElementById('analysis-outliers').innerHTML = `${outlierPercentage}%`;

        // Update the segments tab
        updateSegmentsList(metrics.segments || []);
    } catch (error) {
        console.error('Error updating road analysis panel:', error);
        document.getElementById('analysis-avg-width').innerHTML = 'Error displaying results';
    }
}

// Update the segments list in the Segments tab
function updateSegmentsList(segments) {
    const segmentsList = document.getElementById('segments-list');

    if (!segments || !Array.isArray(segments) || segments.length === 0) {
        segmentsList.innerHTML = '<p>No segments identified.</p>';
        return;
    }

    try {
        let segmentsHtml = '';

        segments.forEach((segment, index) => {
            if (!segment) return;

            const avgWidth = formatNumber(segment.avgWidth || 0);
            const widthCount = segment.widths?.length || 0;

            segmentsHtml += `
                <div class="segment-item" data-segment-index="${index}" onclick="highlightSegment(${index})">
                    <div class="segment-header">
                        <strong>Segment ${index + 1}</strong>
                        <span>${avgWidth} m avg width</span>
                    </div>
                    <div class="segment-metrics">
                        ${widthCount} width measurements
                    </div>
                </div>
            `;
        });

        if (segmentsHtml) {
            segmentsList.innerHTML = segmentsHtml;
        } else {
            segmentsList.innerHTML = '<p>No valid segments to display.</p>';
        }
    } catch (error) {
        console.error('Error updating segments list:', error);
        segmentsList.innerHTML = '<p>Error displaying segments.</p>';
    }
}

// Highlight a specific segment
function highlightSegment(segmentIndex) {
    // Remove highlight from all segments
    document.querySelectorAll('.segment-item').forEach(item => {
        item.classList.remove('selected');
    });

    // Add highlight to selected segment
    const segmentItem = document.querySelector(`.segment-item[data-segment-index="${segmentIndex}"]`);
    if (segmentItem) {
        segmentItem.classList.add('selected');
    }

    // If we have segments on the map, highlight the selected one
    if (roadAnalysisLayers.segments.length > segmentIndex) {
        roadAnalysisLayers.segments.forEach((layer, idx) => {
            if (layer) {
                if (idx === segmentIndex) {
                    layer.setStyle({ color: '#ff9500', weight: 5, opacity: 1 });
                    layer.bringToFront();
                } else {
                    layer.setStyle({ color: '#3388ff', weight: 3, opacity: 0.7 });
                }
            }
        });
    }
}

// Visualize the road analysis results on the map
function visualizeRoadAnalysis(metrics) {
    clearRoadAnalysisVisualization();

    // Validate metrics
    if (!metrics || !metrics.centerline || !metrics.centerline.geometry ||
        !metrics.centerline.geometry.coordinates || metrics.centerline.geometry.coordinates.length === 0) {
        console.warn('Invalid or empty centerline in road analysis metrics');
        document.getElementById('analysis-avg-width').innerHTML = 'No valid centerline found';
        return;
    }

    try {
        // Add centerline if it's valid
        if (metrics.centerline && metrics.centerline.geometry &&
            metrics.centerline.geometry.coordinates &&
            metrics.centerline.geometry.coordinates.length > 0) {

            roadAnalysisLayers.centerline = L.geoJSON(metrics.centerline, {
                style: {
                    color: '#ff9500',
                    weight: 4,
                    opacity: 0.8,
                    dashArray: '10, 5'
                }
            }).addTo(map);
        }

        // Add width lines (non-outliers) if they exist
        if (metrics.widthLines && metrics.widthLines.length > 0) {
            metrics.widthLines.forEach(line => {
                // Validate the line coordinates
                if (line && line.length === 2 && line[0] && line[1] &&
                    line[0].length === 2 && line[1].length === 2) {

                    const widthLine = L.polyline([
                        [line[0][1], line[0][0]], // first point [lat, lng]
                        [line[1][1], line[1][0]]  // second point [lat, lng]
                    ], {
                        color: '#28a745',
                        weight: 2,
                        opacity: 0.7
                    }).addTo(map);

                    roadAnalysisLayers.widthLines.push(widthLine);
                }
            });
        }

        // Add segments if available
        if (metrics.segments && metrics.segments.length > 0) {
            metrics.segments.forEach((segment, index) => {
                if (segment.centerline && segment.centerline.length > 1) {
                    try {
                        // Convert format for Leaflet
                        const points = segment.centerline.map(point => [point[1], point[0]]); // [lat, lng]

                        // Create polyline for segment
                        const segmentLine = L.polyline(points, {
                            color: '#3388ff',
                            weight: 3,
                            opacity: 0.7
                        }).addTo(map);

                        roadAnalysisLayers.segments.push(segmentLine);

                        // Add label at the middle of the segment
                        if (points.length > 1) {
                            const midPointIndex = Math.floor(points.length / 2);
                            const label = L.marker(points[midPointIndex], {
                                icon: L.divIcon({
                                    className: 'segment-label',
                                    html: `<div style="background: rgba(0,0,0,0.7); color: white; padding: 3px 6px; border-radius: 3px;">${index + 1}</div>`,
                                    iconSize: [20, 20],
                                    iconAnchor: [10, 10]
                                })
                            }).addTo(map);

                            roadAnalysisLayers.segmentLabels.push(label);
                        }
                    } catch (e) {
                        console.error(`Error adding segment ${index}:`, e);
                    }
                }
            });
        }

        // Focus map on the analysis area
        focusOnRoadAnalysis();
    } catch (error) {
        console.error('Error visualizing road analysis:', error);
        document.getElementById('analysis-avg-width').innerHTML = 'Error visualizing analysis';
    }
}

// Focus the map view on the road analysis
function focusOnRoadAnalysis() {
    try {
        if (roadAnalysisLayers.centerline && roadAnalysisLayers.centerline.getBounds && !isEmpty(roadAnalysisLayers.centerline.getBounds())) {
            const bounds = roadAnalysisLayers.centerline.getBounds();
            map.fitBounds(bounds, { padding: [50, 50] });
        } else if (roadAnalysisLayers.segments && roadAnalysisLayers.segments.length > 0) {
            // Try to use segments instead if centerline isn't working
            const boundsGroup = L.featureGroup(roadAnalysisLayers.segments.filter(s => s !== null));
            if (boundsGroup.getLayers().length > 0) {
                map.fitBounds(boundsGroup.getBounds(), { padding: [50, 50] });
            } else {
                // Fall back to current parcel
                focusOnCurrentParcel();
            }
        } else {
            // Fall back to current parcel
            focusOnCurrentParcel();
        }
    } catch (error) {
        console.error("Error focusing on road analysis:", error);
        // Safely fall back to current parcel
        focusOnCurrentParcel();
    }
}

// Helper function to check if bounds are empty
function isEmpty(bounds) {
    if (!bounds) return true;
    try {
        const southWest = bounds.getSouthWest();
        const northEast = bounds.getNorthEast();
        return (southWest === undefined || northEast === undefined ||
            !isFinite(southWest.lat) || !isFinite(southWest.lng) ||
            !isFinite(northEast.lat) || !isFinite(northEast.lng) ||
            southWest.lat === 0 && southWest.lng === 0 &&
            northEast.lat === 0 && northEast.lng === 0);
    } catch (e) {
        return true;
    }
}

// Focus on the current parcel
function focusOnCurrentParcel() {
    if (currentParcel && currentParcel.layer) {
        try {
            map.fitBounds(currentParcel.layer.getBounds(), { padding: [50, 50] });
        } catch (error) {
            console.error("Error focusing on current parcel:", error);
        }
    }
}

// Toggle visibility of analysis layers
function toggleAnalysisLayer(layerType) {
    const centerlineCheckbox = document.getElementById('showCenterline');
    const widthLinesCheckbox = document.getElementById('showWidthLines');
    const outliersCheckbox = document.getElementById('showOutliers');

    switch (layerType) {
        case 'centerline':
            if (roadAnalysisLayers.centerline) {
                if (centerlineCheckbox.checked) {
                    map.addLayer(roadAnalysisLayers.centerline);
                } else {
                    map.removeLayer(roadAnalysisLayers.centerline);
                }
            }
            break;

        case 'widthLines':
            roadAnalysisLayers.widthLines.forEach(line => {
                if (widthLinesCheckbox.checked) {
                    map.addLayer(line);
                } else {
                    map.removeLayer(line);
                }
            });
            break;

        case 'outliers':
            roadAnalysisLayers.outlierLines.forEach(line => {
                if (outliersCheckbox.checked) {
                    map.addLayer(line);
                } else {
                    map.removeLayer(line);
                }
            });
            break;
    }
}

// Switch between tabs in the Road Analysis panel
function switchTab(button, tabId) {
    // Remove active class from all tab buttons and content
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.remove('active');
    });

    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.remove('active');
    });

    // Add active class to selected tab button and content
    button.classList.add('active');
    document.getElementById(tabId).classList.add('active');
}

// Helper function to format numbers
function formatNumber(value) {
    if (typeof value !== 'number') return '0';
    return value.toLocaleString('hr-HR', {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1
    });
}
