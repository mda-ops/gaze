// Fixed rosters from the Python app (web.py). They make models and chatters
// appear on the revenue pages even in a period without revenue. Edit here when
// the agency's roster changes.

// Model -> platforms its card always shows (Python: MODEL_PLATFORM_DEFAULTS).
export const MODEL_PLATFORM_DEFAULTS: Record<string, string[]> = {
    Anna: ['F2F', 'OF'],
    Annie: ['OF'],
    Bibi: ['F2F'],
    Delisha: ['F2F', 'KNKY'],
    Demi: ['F2F', 'OF'],
    Emilia: ['OF'],
    Emma: ['F2F', 'KNKY', 'OF'],
    Famke: ['F2F'],
    Francis: ['F2F', 'OF'],
    'Gabriële': ['F2F'],
    Gigi: ['F2F', 'OF'],
    Jane: ['F2F', 'KNKY', 'OF'],
    Jill: ['F2F', 'OF'],
    Jolie: ['OF'],
    Kim: ['F2F'],
    Kimmy: ['F2F', 'OF'],
    Kirsten: ['F2F', 'OF'],
    Larissa: ['F2F'],
    Lesley: ['F2F', 'OF'],
    Lianne: ['F2F'],
    Lisa: ['F2F', 'OF'],
    Nadine: ['F2F', 'OF'],
    Raluca: ['F2F'],
    Romee: ['F2F'],
    Rosalie: ['F2F'],
    Sebine: ['F2F', 'KNKY', 'OF'],
    Sophie: ['F2F'],
    Vivian: ['F2F', 'OF'],
    Ylona: ['F2F', 'OF'],
    Zoe: ['F2F'],
};

// Agencies always offered by the model filter (Python: MODEL_REVENUE_AGENCIES).
export const MODEL_REVENUE_AGENCIES = ['Mucho Dinero Agency', 'YS Agency', 'Aljaz'];

// Python: agency_display_name.
export function agencyLabel(value: string | null | undefined): string {
    const label = (value ?? '').trim();
    const key = label.toLowerCase();
    if (['md', 'mucho dinero', 'mucho dinero agency'].includes(key)) return 'Mucho Dinero Agency';
    if (['ys', 'ys agency'].includes(key)) return 'YS Agency';
    if (['aljaz', 'aljaz agency', 'aljaž', 'aljaž agency'].includes(key)) return 'Aljaz';
    return label || 'Unknown';
}

// Chatter cards: platforms by team (matched as a substring of the team name)
// and per-chatter exceptions (Python: CHATTER_TEAM_PLATFORM_DEFAULTS,
// CHATTER_PLATFORM_DEFAULTS). Lower-case keys.
export const CHATTER_TEAM_PLATFORM_DEFAULTS: [team: string, platforms: string[]][] = [
    ['dutch', ['F2F', 'KNKY']],
    ['english', ['OF']],
];

export const CHATTER_PLATFORM_DEFAULTS: Record<string, string[]> = {
    aaliyah: ['OF'],
    brigit: ['OF'],
    daryll: ['OF'],
    franz: ['OF'],
    jacinta: ['OF'],
    jyuanez: ['OF'],
    julianne: ['OF'],
    kianna: ['OF'],
    maureen: ['OF'],
    phina: ['OF'],
    xavier: ['OF'],
    yvan: ['OF'],
};

// Python: chatter_default_platforms.
export function chatterDefaultPlatforms(team: string | undefined, chatter: string): string[] {
    const own = CHATTER_PLATFORM_DEFAULTS[chatter.trim().toLowerCase()];
    if (own) return [...own];
    const teamKey = (team ?? '').trim().toLowerCase();
    for (const [label, platforms] of CHATTER_TEAM_PLATFORM_DEFAULTS) {
        if (teamKey.includes(label)) return [...platforms];
    }
    return ['F2F'];
}
