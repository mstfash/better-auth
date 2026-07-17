import type { APIError } from "better-auth/api";
import { jwt } from "better-auth/plugins/jwt";
import { getTestInstance } from "better-auth/test";
import { describe, expect, it } from "vitest";
import { oauthProvider } from "../oauth";

describe("server-only OAuth client management", async () => {
	const { auth } = await getTestInstance({
		plugins: [
			oauthProvider({
				loginPage: "/login",
				consentPage: "/consent",
				serverOnlyClientManagement: true,
				clientPrivileges: async () => false,
				storeClientSecret: "hashed",
				silenceWarnings: {
					oauthAuthServerConfig: true,
					openidConfig: true,
				},
			}),
			jwt(),
		],
	});

	it("keeps public management denied while trusted server calls own the lifecycle", async () => {
		const created = await auth.api.adminCreateOAuthClient({
			body: {
				client_name: "AuthOwl dashboard application",
				redirect_uris: ["https://app.example.com/callback"],
				post_logout_redirect_uris: ["https://app.example.com/signed-out"],
				grant_types: ["authorization_code", "refresh_token"],
				response_types: ["code"],
				type: "web",
				enable_end_session: true,
			},
		});

		expect(created.client_id).toBeDefined();
		expect(created.client_secret).toBeDefined();

		await expect(
			auth.api.updateOAuthClient({
				body: {
					client_id: created.client_id,
					update: { client_name: "Denied public update" },
				},
			}),
		).rejects.toMatchObject({
			status: "UNAUTHORIZED",
			statusCode: 401,
		} satisfies Partial<APIError>);

		const updated = await auth.api.adminUpdateOAuthClient({
			body: {
				client_id: created.client_id,
				update: {
					client_name: "Updated dashboard application",
					disabled: true,
				},
			},
		});
		expect(updated).toMatchObject({
			client_id: created.client_id,
			client_name: "Updated dashboard application",
			disabled: true,
		});
		expect(updated.client_secret).toBeUndefined();

		const clearedLogoutRedirects = await auth.api.adminUpdateOAuthClient({
			body: {
				client_id: created.client_id,
				update: { post_logout_redirect_uris: [] },
			},
		});
		expect(clearedLogoutRedirects.post_logout_redirect_uris).toEqual([]);

		const rotated = await auth.api.adminRotateClientSecret({
			body: { client_id: created.client_id },
		});
		expect(rotated.client_id).toBe(created.client_id);
		expect(rotated.client_secret).toBeDefined();
		expect(rotated.client_secret).not.toBe(created.client_secret);

		const deleted = await auth.api.adminDeleteOAuthClient({
			body: { client_id: created.client_id },
		});
		expect(deleted).toBeUndefined();

		await expect(
			auth.api.adminUpdateOAuthClient({
				body: {
					client_id: created.client_id,
					update: { disabled: false },
				},
			}),
		).rejects.toMatchObject({
			status: "NOT_FOUND",
			statusCode: 404,
		} satisfies Partial<APIError>);
	});

	it("defaults new server-only mutations to session authorization", async () => {
		const { auth: restrictedAuth } = await getTestInstance({
			plugins: [
				oauthProvider({
					loginPage: "/login",
					consentPage: "/consent",
					clientPrivileges: async () => true,
					silenceWarnings: {
						oauthAuthServerConfig: true,
						openidConfig: true,
					},
				}),
				jwt(),
			],
		});

		for (const operation of [
			() =>
				restrictedAuth.api.adminRotateClientSecret({
					body: { client_id: "missing-client" },
				}),
			() =>
				restrictedAuth.api.adminDeleteOAuthClient({
					body: { client_id: "missing-client" },
				}),
		]) {
			await expect(operation()).rejects.toMatchObject({
				status: "UNAUTHORIZED",
				statusCode: 401,
			} satisfies Partial<APIError>);
		}
	});
});
