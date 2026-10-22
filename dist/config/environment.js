function parseEnvironmentUrl(name, value) {
    try {
        return new URL(value);
    }
    catch {
        throw new Error(`${name} must be a valid absolute URL`);
    }
}
export function validateEnvironment() {
    const required = [
        'DATABASE_URL',
        'PAYSTACK_SECRET_KEY',
        'BETTER_AUTH_SECRET',
        'BETTER_AUTH_URL',
        'SUPABASE_URL',
        'SUPABASE_SERVICE_ROLE_KEY',
        'FRONTEND_ORIGINS',
    ];
    const missing = required.filter((key) => !process.env[key]?.trim());
    if (process.env.NODE_ENV === 'production') {
        for (const key of ['RESEND_API_KEY', 'RESEND_FROM_EMAIL']) {
            if (!process.env[key]?.trim())
                missing.push(key);
        }
    }
    if (process.env.RESEND_SEND_IN_DEVELOPMENT === 'true') {
        for (const key of ['RESEND_API_KEY', 'RESEND_FROM_EMAIL']) {
            if (!process.env[key]?.trim())
                missing.push(key);
        }
    }
    if (missing.length)
        throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    const authSecret = process.env.BETTER_AUTH_SECRET;
    if (authSecret.length < 32)
        throw new Error('BETTER_AUTH_SECRET must be at least 32 characters');
    const databaseUrl = parseEnvironmentUrl('DATABASE_URL', process.env.DATABASE_URL);
    if (databaseUrl.hostname.includes('pooler') && databaseUrl.port !== '6543') {
        throw new Error('The application database pooler connection must use port 6543');
    }
    if (databaseUrl.hostname.endsWith('.supabase.co')) {
        throw new Error('The application must use the Supabase pooler URL on port 6543, not the direct database host');
    }
    const origins = process.env.FRONTEND_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean);
    if (origins.length === 0 || origins.some((origin) => !/^https?:\/\/[^/]+$/.test(origin))) {
        throw new Error('FRONTEND_ORIGINS must be a comma-separated list of origin URLs without paths');
    }
    const commissionRate = Number(process.env.DEFAULT_COMMISSION_BPS ?? 1000);
    if (!Number.isSafeInteger(commissionRate) || commissionRate < 0 || commissionRate > 10_000) {
        throw new Error('DEFAULT_COMMISSION_BPS must be an integer between 0 and 10000');
    }
    parseEnvironmentUrl('BETTER_AUTH_URL', process.env.BETTER_AUTH_URL);
    parseEnvironmentUrl('SUPABASE_URL', process.env.SUPABASE_URL);
    return { frontendOrigins: origins };
}
