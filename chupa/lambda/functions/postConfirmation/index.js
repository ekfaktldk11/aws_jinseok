import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.USERS_TABLE;

// Users 레코드 자동 프로비저닝.
//   카카오(OIDC 페더레이션) 로그인은 PostConfirmation 트리거가 발생하지 않으므로
//   (외부 IdP 유저는 'confirm sign-up' 단계가 없음), 매 로그인마다 호출되는
//   PostAuthentication 에서 "없으면 생성"(조건부 Put)으로 레코드 존재를 보장한다.
//   조건부 Put 이라 첫 로그인 1회만 실제 생성되고 이후엔 no-op(idempotent).
export const handler = async (event) => {
  const { sub, email, name, picture } = event.request?.userAttributes || {};

  // sub 가 없으면(이론상 없음) 조용히 통과.
  if (!sub) return event;

  try {
    await ddb.send(new PutCommand({
      TableName: TABLE,
      Item: {
        userId: sub,
        email: email || "",
        name: name || "",
        photos: picture ? [picture] : [],
        bio: "",
        interests: [],
        age: null,
        status: "active",
        signalConsent: false, // 🔒 2단계 수신 동의 게이팅용. MVP 미사용(기본 false).
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      ConditionExpression: "attribute_not_exists(userId)",
    }));

    console.log(`User provisioned: ${sub} (${email})`);
  } catch (err) {
    if (err.name !== "ConditionalCheckFailedException") {
      // ⚠️ PostAuthentication 에서 throw 하면 로그인 자체가 실패한다.
      //   프로비저닝 실패는 로그만 남기고 통과 — 다음 로그인에 자동 재시도(멱등).
      console.error("User provisioning failed:", err);
    }
  }

  return event;
};
