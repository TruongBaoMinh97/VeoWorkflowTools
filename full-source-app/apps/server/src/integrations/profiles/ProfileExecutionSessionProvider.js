import { ProfileExecutionSessionProviderContract } from '../../contracts/integration.js';
import { accountLocaleService } from '../../lib/accountLocaleService.js';
import { prisma } from '../../lib/prisma.js';
import { getProfileCookiesCompat } from '../../utils/profileCookies.js';

function serializeCookies(profileCookiesJson) {
    if (!profileCookiesJson)
        return undefined;
    try {
        const parsed = JSON.parse(profileCookiesJson);
        return Array.isArray(parsed)
            ? parsed.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
            : profileCookiesJson;
    }
    catch {
        return profileCookiesJson;
    }
}

export class ProfileExecutionSessionProvider extends ProfileExecutionSessionProviderContract {
    async getExecutionSession(profile, options = {}) {
        const { cookies: profileCookiesJson } = await getProfileCookiesCompat(profile);
        const cookies = serializeCookies(profileCookiesJson);
        const locale = cookies
            ? await accountLocaleService.getAccountLocale(profile.id, cookies, undefined, 'vi')
            : 'vi';

        return {
            accessToken: profile.accessToken ?? undefined,
            cookies,
            profileId: profile.id,
            veo3ProjectId: options.veo3ProjectId ?? undefined,
            locale,
            onTokenRefreshed: async (newToken) => {
                await prisma.profile.update({
                    where: { id: profile.id },
                    data: {
                        accessToken: newToken,
                        accessTokenExpires: new Date(Date.now() + 55 * 60 * 1000),
                    },
                });
            },
        };
    }
}

export const profileExecutionSessionProvider = new ProfileExecutionSessionProvider();
