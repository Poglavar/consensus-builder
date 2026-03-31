function ok(value) {
    return { ok: true, value };
}

function fail(error) {
    return { ok: false, error };
}

export function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

export function createJsonBodyValidator({ schema, allowUnknownFields = false, unknownFieldsMessage = 'Request body contains unsupported fields.' }) {
    return (req, res, next) => {
        const body = req.body;
        if (!isPlainObject(body)) {
            return res.status(400).json({ error: 'Invalid request body. Expected a JSON object.' });
        }

        if (!allowUnknownFields) {
            const allowedFields = new Set(Object.keys(schema));
            const hasUnknownFields = Object.keys(body).some(key => !allowedFields.has(key));
            if (hasUnknownFields) {
                return res.status(400).json({ error: unknownFieldsMessage });
            }
        }

        const validatedBody = {};
        for (const [fieldName, rule] of Object.entries(schema)) {
            const hasValue = Object.prototype.hasOwnProperty.call(body, fieldName);
            if (!hasValue) {
                if (rule.required) {
                    return res.status(400).json({ error: rule.missingMessage || `${fieldName} is required.` });
                }
                continue;
            }

            const result = rule.validate(body[fieldName], fieldName, body);
            if (!result.ok) {
                return res.status(400).json({ error: result.error });
            }
            validatedBody[fieldName] = result.value;
        }

        req.validatedBody = validatedBody;
        return next();
    };
}

function normalizeString(value, { trim = true } = {}) {
    return trim && typeof value === 'string' ? value.trim() : value;
}

function resolveFieldLabel(fieldName, label) {
    return label || fieldName;
}

export const validators = {
    optional(validator, { nullValue = null, treatEmptyStringAsMissing = true } = {}) {
        return (value, fieldName, body) => {
            if (value === undefined || value === null) {
                return ok(nullValue);
            }
            if (treatEmptyStringAsMissing && typeof value === 'string' && value.trim() === '') {
                return ok(nullValue);
            }
            return validator(value, fieldName, body);
        };
    },

    string({
        trim = true,
        minLength = null,
        maxLength = null,
        pattern = null,
        disallowControlChars = false,
        label = null,
        typeMessage = null,
        minLengthMessage = null,
        maxLengthMessage = null,
        patternMessage = null,
        controlCharsMessage = null
    } = {}) {
        return (value, fieldName) => {
            const fieldLabel = resolveFieldLabel(fieldName, label);
            if (typeof value !== 'string') {
                return fail(typeMessage || `${fieldLabel} must be a string.`);
            }

            const normalized = normalizeString(value, { trim });
            if (minLength != null && normalized.length < minLength) {
                return fail(minLengthMessage || `${fieldLabel} must be at least ${minLength} characters.`);
            }
            if (maxLength != null && normalized.length > maxLength) {
                return fail(maxLengthMessage || `${fieldLabel} must be at most ${maxLength} characters.`);
            }
            if (disallowControlChars && /\p{C}/u.test(normalized)) {
                return fail(controlCharsMessage || `${fieldLabel} contains invalid control characters.`);
            }
            if (pattern && !pattern.test(normalized)) {
                return fail(patternMessage || `${fieldLabel} has an invalid format.`);
            }

            return ok(normalized);
        };
    },

    boolean({ label = null, typeMessage = null } = {}) {
        return (value, fieldName) => {
            const fieldLabel = resolveFieldLabel(fieldName, label);
            if (typeof value !== 'boolean') {
                return fail(typeMessage || `${fieldLabel} must be a boolean.`);
            }

            return ok(value);
        };
    },

    finiteNumber({
        label = null,
        integer = false,
        min = null,
        max = null,
        allowNumericString = true,
        typeMessage = null,
        integerMessage = null,
        minMessage = null,
        maxMessage = null
    } = {}) {
        return (value, fieldName) => {
            const fieldLabel = resolveFieldLabel(fieldName, label);

            let numericValue = value;
            if (allowNumericString && typeof numericValue === 'string') {
                const trimmed = numericValue.trim();
                if (trimmed === '') {
                    return fail(typeMessage || `${fieldLabel} must be a valid number.`);
                }
                numericValue = Number(trimmed);
            }

            if (typeof numericValue !== 'number' || !Number.isFinite(numericValue)) {
                return fail(typeMessage || `${fieldLabel} must be a valid number.`);
            }

            if (integer && !Number.isInteger(numericValue)) {
                return fail(integerMessage || `${fieldLabel} must be an integer.`);
            }
            if (min != null && numericValue < min) {
                return fail(minMessage || `${fieldLabel} must be at least ${min}.`);
            }
            if (max != null && numericValue > max) {
                return fail(maxMessage || `${fieldLabel} must be at most ${max}.`);
            }

            return ok(numericValue);
        };
    },

    plainObject({ label = null, typeMessage = null } = {}) {
        return (value, fieldName) => {
            const fieldLabel = resolveFieldLabel(fieldName, label);
            if (!isPlainObject(value)) {
                return fail(typeMessage || `${fieldLabel} must be an object.`);
            }

            return ok(value);
        };
    },

    date({ label = null, typeMessage = null, invalidMessage = null } = {}) {
        return (value, fieldName) => {
            const fieldLabel = resolveFieldLabel(fieldName, label);

            if (typeof value !== 'string' && typeof value !== 'number' && !(value instanceof Date)) {
                return fail(typeMessage || `${fieldLabel} must be a valid date value.`);
            }

            const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
            if (Number.isNaN(parsed.getTime())) {
                return fail(invalidMessage || `${fieldLabel} must be a valid date.`);
            }

            return ok(parsed);
        };
    },

    arrayOf(itemValidator, {
        minItems = null,
        maxItems = null,
        unique = false,
        label = null,
        typeMessage = null,
        minItemsMessage = null,
        maxItemsMessage = null,
        uniqueMessage = null
    } = {}) {
        return (value, fieldName, body) => {
            const fieldLabel = resolveFieldLabel(fieldName, label);
            if (!Array.isArray(value)) {
                return fail(typeMessage || `${fieldLabel} must be an array.`);
            }
            if (minItems != null && value.length < minItems) {
                return fail(minItemsMessage || `${fieldLabel} must contain at least ${minItems} items.`);
            }
            if (maxItems != null && value.length > maxItems) {
                return fail(maxItemsMessage || `${fieldLabel} must contain at most ${maxItems} items.`);
            }

            const normalized = [];
            for (const item of value) {
                const result = itemValidator(item, fieldName, body);
                if (!result.ok) {
                    return result;
                }
                normalized.push(result.value);
            }

            if (unique && new Set(normalized).size !== normalized.length) {
                return fail(uniqueMessage || `${fieldLabel} must not contain duplicates.`);
            }

            return ok(normalized);
        };
    },

    httpUrl({ maxLength = null, label = null } = {}) {
        return (value, fieldName) => {
            const fieldLabel = resolveFieldLabel(fieldName, label);
            if (typeof value !== 'string') {
                return fail(`${fieldLabel} must be a string.`);
            }

            const normalized = value.trim();
            if (maxLength != null && normalized.length > maxLength) {
                return fail(`${fieldLabel} must be at most ${maxLength} characters.`);
            }

            let parsed;
            try {
                parsed = new URL(normalized);
            } catch {
                return fail(`${fieldLabel} must be a valid absolute URL.`);
            }

            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                return fail(`${fieldLabel} must use http or https.`);
            }

            return ok(normalized);
        };
    },

    custom(validate) {
        return (value, fieldName, body) => validate(value, fieldName, body);
    },

    ok,
    fail
};