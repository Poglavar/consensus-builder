// This module has one function that takes as argument the path to the .env
// file it needs to update and the name and value of the variable it needs to update.
// It will update the .env file with the new value.
// It will first check if the .env file exists, if not it will stop and print an error message.
// If the .env file exists it will update the variable with the new value, if the variable exists,
// or create a new row with the variable name and value, if it doesn't exist.
// If it existed it will also create a row "# update-dotenv bkp <timestamp> <variableName> <originalValue>" with the original value.

const fs = require('fs');
const path = require('path');

/**
 * Update or insert an env var in a .env file, backing up prior value.
 * @param {string} dotenvPath absolute or relative path to the .env file
 * @param {string} variableName env var key to update
 * @param {string} variableValue new value to write
 * @returns {boolean} true on success, false on failure
 */
function updateDotenv(dotenvPath, variableName, variableValue) {
    const resolvedPath = path.resolve(dotenvPath);

    if (!fs.existsSync(resolvedPath)) {
        console.error(`.env file not found at: ${resolvedPath}`);
        return false;
    }

    const raw = fs.readFileSync(resolvedPath, 'utf8');
    const lines = raw.split(/\r?\n/);

    let found = false;
    const timestamp = new Date().toISOString();
    const backupCommentPrefix = '# update-dotenv bkp';
    const updatedLines = [];

    for (const line of lines) {
        const match = line.match(/^([\s]*)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (!found && match && match[2] === variableName) {
            const originalValue = match[3];
            // Replace the variable line
            updatedLines.push(`${variableName}=${variableValue}`);
            // Add backup comment
            updatedLines.push(`${backupCommentPrefix} ${timestamp} ${variableName} ${originalValue}`);
            found = true;
        } else {
            updatedLines.push(line);
        }
    }

    if (!found) {
        // Append new var
        if (updatedLines.length && updatedLines[updatedLines.length - 1] !== '') {
            updatedLines.push(''); // ensure trailing newline before appending
        }
        updatedLines.push(`${variableName}=${variableValue}`);
    }

    // Ensure file ends with newline
    const output = updatedLines.join('\n');
    fs.writeFileSync(resolvedPath, output.endsWith('\n') ? output : `${output}\n`, 'utf8');
    return true;
}

module.exports = {
    updateDotenv,
};