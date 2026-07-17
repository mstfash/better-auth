import type { GenericEndpointContext } from "@better-auth/core";
import type { User } from "better-auth/types";
import { APIError } from "better-call";
import { validateAccessToken } from "./introspect";
import type { OAuthOptions, Scope } from "./types";
import { getClient, resolveSubjectIdentifier } from "./utils";

/**
 * Provides shared /userinfo and id_token claims functionality
 *
 * @see https://openid.net/specs/openid-connect-core-1_0.html#NormalClaims
 */
export function userNormalClaims(user: User, scopes: string[]) {
	const name = user.name.split(" ").filter((v) => v !== "");
	const profile = {
		name: user.name ?? undefined,
		picture: user.image ?? undefined,
		given_name: name.length > 1 ? name.slice(0, -1).join(" ") : undefined,
		family_name: name.length > 1 ? name.at(-1) : undefined,
	};
	const email = {
		email: user.email ?? undefined,
		email_verified: user.emailVerified ?? false,
	};

	return {
		sub: user.id ?? undefined,
		...(scopes.includes("profile") ? profile : {}),
		...(scopes.includes("email") ? email : {}),
	};
}

function invalidAccessToken(): APIError {
	return new APIError("UNAUTHORIZED", {
		error_description: "Invalid access token",
		error: "invalid_token",
	});
}

function insufficientOpenIdScope(): APIError {
	return new APIError("FORBIDDEN", {
		error_description: "Missing required openid scope",
		error: "insufficient_scope",
	});
}

/**
 * Handles the /oauth2/userinfo endpoint
 */
export async function userInfoEndpoint(
	ctx: GenericEndpointContext,
	opts: OAuthOptions<Scope[]>,
) {
	const authorization = ctx.headers?.get("authorization");
	const token =
		typeof authorization === "string" && authorization?.startsWith("Bearer ")
			? authorization?.replace("Bearer ", "")
			: authorization;
	if (!token?.length) {
		throw new APIError("UNAUTHORIZED", {
			error_description: "authorization header not found",
			error: "invalid_request",
		});
	}
	let jwt: Awaited<ReturnType<typeof validateAccessToken>>;
	try {
		jwt = await validateAccessToken(ctx, opts, token);
	} catch (error) {
		if (error instanceof APIError) throw invalidAccessToken();
		throw error;
	}
	if (jwt.active !== true) throw invalidAccessToken();

	const scopes = (jwt.scope as string | undefined)?.split(" ");
	if (!scopes?.includes("openid")) {
		throw insufficientOpenIdScope();
	}

	if (!jwt.sub) {
		throw invalidAccessToken();
	}

	const user = await ctx.context.internalAdapter.findUserById(jwt.sub);
	if (!user) {
		throw invalidAccessToken();
	}

	const baseUserClaims = userNormalClaims(user, scopes ?? []);

	// Resolve pairwise sub if server has pairwise enabled and client is configured for it
	if (opts.pairwiseSecret) {
		const clientId = (jwt.client_id ?? jwt.azp) as string | undefined;
		if (clientId) {
			const client = await getClient(ctx, opts, clientId);
			if (client) {
				baseUserClaims.sub = await resolveSubjectIdentifier(
					user.id,
					client,
					opts,
				);
			}
		}
	}
	const additionalInfoUserClaims =
		opts.customUserInfoClaims && scopes?.length
			? await opts.customUserInfoClaims({ user, scopes, jwt })
			: {};
	return {
		...baseUserClaims,
		...additionalInfoUserClaims,
	};
}
