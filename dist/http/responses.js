export function apiError(code, message, details) {
    return {
        error: {
            code,
            message,
            ...(details === undefined ? {} : { details }),
        },
    };
}
