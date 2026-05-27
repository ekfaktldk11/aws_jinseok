// ════════════════════════════════════════════════════════════════
// Chupa 공유 유틸리티
//
// ※ 원본은 lambda/shared/utils.js 한 곳뿐입니다. 수정은 반드시 거기서.
//   각 함수 폴더의 shared.js 는 sync-shared.js 가 복사한 사본이므로
//   직접 수정하면 다음 동기화 때 덮어쓰여 사라집니다.
// ════════════════════════════════════════════════════════════════
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";

// ────────────────────────────────────────────
// AWS clients (재사용을 위해 모듈 스코프에서 한 번만 생성)
// ────────────────────────────────────────────
const ddbClient = new DynamoDBClient({});
export const ddb = DynamoDBDocumentClient.from(ddbClient);

const snsClient = new SNSClient({});

// ────────────────────────────────────────────
// HTTP 응답 헬퍼
// ────────────────────────────────────────────
const headers = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
};

export function ok(body) {
  return { statusCode: 200, headers, body: JSON.stringify(body) };
}

export function created(body) {
  return { statusCode: 201, headers, body: JSON.stringify(body) };
}

export function badRequest(message) {
  return { statusCode: 400, headers, body: JSON.stringify({ error: message }) };
}

export function notFound(message = "Not found") {
  return { statusCode: 404, headers, body: JSON.stringify({ error: message }) };
}

export function forbidden(message = "Forbidden") {
  return { statusCode: 403, headers, body: JSON.stringify({ error: message }) };
}

export function serverError(message = "Internal server error") {
  return { statusCode: 500, headers, body: JSON.stringify({ error: message }) };
}

// ────────────────────────────────────────────
// Cognito 인증 정보 추출
// ────────────────────────────────────────────
export function getUserIdFromEvent(event) {
  return event.requestContext?.authorizer?.claims?.sub || null;
}

// ────────────────────────────────────────────
// 푸시 알림 발송 (SNS publish)
// PUSH_TOPIC_ARN 환경변수가 설정된 람다에서만 호출 가능.
// 발송 실패는 silent 처리 - 메인 비즈니스 로직을 막지 않음.
// ────────────────────────────────────────────
export async function publishNotification({ type, userId, data }) {
  const TopicArn = process.env.PUSH_TOPIC_ARN;
  if (!TopicArn) {
    console.warn("PUSH_TOPIC_ARN 미설정 - 알림 발송 건너뜀");
    return;
  }
  try {
    await snsClient.send(new PublishCommand({
      TopicArn,
      Message: JSON.stringify({ type, userId, data }),
    }));
  } catch (err) {
    console.error("SNS publish failed:", err);
  }
}
