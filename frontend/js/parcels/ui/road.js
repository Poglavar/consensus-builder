(function (global) {
    'use strict';

    function measureAsRoad() {
        if (!global.currentParcel || !global.currentParcel.layer) {
            if (typeof global.updateStatus === 'function') {
                global.updateStatus(global.tParcel('panel.parcel.actions.measureStatusNoParcel', {}, 'No parcel selected for road measurement.'));
            }
            return;
        }

        const button = document.getElementById('measureAsRoadButton');
        const measurementsDiv = document.getElementById('roadMeasurements');
        if (!button || !measurementsDiv) return;

        button.innerHTML = global.tParcel('panel.parcel.actions.measureLoading', {}, '⏳ Calculating...');
        button.disabled = true;

        try {
            const feature = global.currentParcel.layer.feature;
            const metrics = global.calculateRoadMetrics(feature.geometry.coordinates);

            const formattedLength = metrics ? Number(metrics.length).toLocaleString('hr-HR', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) : 'N/A';
            const formattedAvgWidth = metrics ? Number(metrics.widths.average).toLocaleString('hr-HR', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) : 'N/A';
            const formattedMaxWidth = metrics ? Number(metrics.widths.maximum).toLocaleString('hr-HR', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) : 'N/A';
            const formattedMinWidth = metrics ? Number(metrics.widths.minimum).toLocaleString('hr-HR', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) : 'N/A';
            const formattedTolerance = metrics ? Number(metrics.widths.tolerancePercentage).toLocaleString('hr-HR', { minimumFractionDigits: 0, maximumFractionDigits: 1 }) : 'N/A';

            const lengthLabel = global.tParcel('panel.parcel.actions.measureLengthLabel', {}, 'As Road Length:');
            const widthLabel = global.tParcel('panel.parcel.actions.measureWidthLabel', {}, 'As Road Width:');
            const widthAverageLabel = global.tParcel('panel.parcel.actions.measureWidthAverage', {}, 'Average:');
            const widthMaximumLabel = global.tParcel('panel.parcel.actions.measureWidthMaximum', {}, 'Maximum:');
            const widthMinimumLabel = global.tParcel('panel.parcel.actions.measureWidthMinimum', {}, 'Minimum:');
            const consistencyLabel = global.tParcel('panel.parcel.actions.measureConsistencyLabel', {}, 'As Road Width Consistency:');
            const toleranceText = global.tParcel('panel.parcel.actions.measureToleranceText', { percent: formattedTolerance }, `${formattedTolerance}% within ±10% of average`);

            measurementsDiv.innerHTML = `
        <hr style="border: 0; height: 1px; background-color: #ddd; margin: 10px 0;">
        <div class="metric-group">
            <div class="metric-label">${lengthLabel}</div>
            <div class="metric-value">${formattedLength} m</div>
        </div>
        <div class="metric-group">
            <div class="metric-label">${widthLabel}</div>
            <div class="metric-value">
                ${widthAverageLabel} ${formattedAvgWidth} m<br>
                ${widthMaximumLabel} ${formattedMaxWidth} m<br>
                ${widthMinimumLabel} ${formattedMinWidth} m
            </div>
        </div>
        <div class="metric-group">
            <div class="metric-label">${consistencyLabel}</div>
            <div class="metric-value">${toleranceText}</div>
        </div>
    `;

            measurementsDiv.style.display = 'block';
            button.innerHTML = global.tParcel('panel.parcel.actions.measurementsAdded', {}, 'Measurements added');
            button.disabled = true;

            if (typeof global.updateStatus === 'function') {
                global.updateStatus(global.tParcel('panel.parcel.actions.measureStatusSuccess', {}, 'Road measurements calculated and added to panel.'));
            }
        } catch (error) {
            console.error('Error calculating road metrics:', error);
            if (typeof global.updateStatus === 'function') {
                global.updateStatus(global.tParcel('panel.parcel.actions.measureStatusError', {}, 'Error calculating road measurements.'));
            }
            button.innerHTML = global.tParcel('panel.parcel.actions.measureAsRoad', {}, 'Measure as road');
            button.disabled = false;
        }
    }

    global.measureAsRoad = measureAsRoad;
})(typeof window !== 'undefined' ? window : globalThis);

