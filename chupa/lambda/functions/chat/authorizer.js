// ════════════════════════════════════════════════════════════════
// WebSocket $connect Lambda Authorizer
//   클라가 핸드셰이크 때 보낸 Cognito id_token 을 검증한다.
//   (브라우저 WebSocket 은 헤더를 못 넣으므로 토큰은 쿼리스트링 ?token= 으로 받는다.)
//
//   검증 통과 시 IAM Allow 정책 + context.userId(= 토큰 sub) 반환.
//   → $connect 람다는 이 검증된 sub 만 신뢰한다(쿼리스트링 userId 신뢰 제거).
//
//   의존성 0: node:crypto + 전역 fetch 만 사용(런타임 내장).
// ════════════════════════════════════════════════════════════════
import { createPublicKey, verify as cryptoVerify } from "node:crypto";

const REGION = process.env.AWS_REGION;            // 람다가 자동 주입
const USER_POOL_ID = process.env.USER_POOL_ID;
const CLIENT_ID = process.env.CLIENT_ID;
const ISSUER = `https://cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}`;
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;

// kid → 공개키. 모듈 스코프 캐시(콜드스타트 1회 fetch). 키 회전 시 무효화 후 재조회.
let jwksCache = null;

async function getKeys(forceRefresh = false) {
  if (jwksCache && !forceRefresh) return jwksCache;
  const res = await fetch(JWKS_URL);
  if (!res.ok) throw new Error(`JWKS fetch ${res.status}`);
  const { keys } = await res.json();
  const map = {};
  for (const jwk of keys) map[jwk.kid] = createPublicKey({ key: jwk, format: "jwk" });
  jwksCache = map;
  return map;
}

const b64url = (s) => Buffer.from(s, "base64url");
const decodeSegment = (seg) => JSON.parse(b64url(seg).toString("utf8"));

async function verifyIdToken(token) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed token");
  const [headerB64, payloadB64, sigB64] = parts;

  const header = decodeSegment(headerB64);
  if (header.alg !== "RS256") throw new Error(`unexpected alg ${header.alg}`);

  // 키 회전 대비: kid 가 캐시에 없으면 한 번 강제 재조회.
  let keys = await getKeys();
  if (!keys[header.kid]) keys = await getKeys(true);
  const key = keys[header.kid];
  if (!key) throw new Error("unknown kid");

  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`);
  if (!cryptoVerify("RSA-SHA256", signingInput, key, b64url(sigB64))) {
    throw new Error("bad signature");
  }

  const claims = decodeSegment(payloadB64);
  const now = Math.floor(Date.now() / 1000);
  if (!claims.exp || claims.exp < now) throw new Error("expired");
  if (claims.iss !== ISSUER) throw new Error("bad issuer");
  if (claims.token_use !== "id") throw new Error("not an id token"); // access_token 거부
  if (CLIENT_ID && claims.aud !== CLIENT_ID) throw new Error("bad audience");
  if (!claims.sub) throw new Error("no sub");
  return claims;
}

function policy(principalId, effect, resource, context) {
  return {
    principalId,
    policyDocument: {
      Version: "2012-10-17",
      Statement: [{ Action: "execute-api:Invoke", Effect: effect, Resource: resource }],
    },
    ...(context ? { context } : {}),
  };
}

export const handler = async (event) => {
  const token = event.queryStringParameters?.token;
  const resource = event.methodArn || "*";
  try {
    if (!token) throw new Error("no token");
    const claims = await verifyIdToken(token);
    // context 값은 문자열만 허용 → $connect 에서 event.requestContext.authorizer.userId 로 읽음.
    return policy(claims.sub, "Allow", resource, { userId: claims.sub });
  } catch (err) {
    console.error("WS authorizer deny:", err.message);
    return policy("anonymous", "Deny", resource);
  }
};
