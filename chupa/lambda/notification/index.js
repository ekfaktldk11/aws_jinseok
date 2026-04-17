// SNS 트리거로 실행되는 알림 Lambda
// FCM/APNs로 실제 푸시 전송

exports.handler = async (event) => {
  for (const record of event.Records) {
    const message = JSON.parse(record.Sns.Message);
    const { type, userId, data } = message;

    console.log(`Sending notification: type=${type}, userId=${userId}`);

    switch (type) {
      case "chupa_received":
        await sendPush(userId, {
          title: "추파 🫶",
          body: "누군가 추파를 던졌어요!",
          data: { screen: "ChupaList" },
        });
        break;

      case "match_success":
        await sendPush(userId, {
          title: "매칭 성공! 🎉",
          body: `${data.partnerName}님과 매칭되었어요!`,
          data: { screen: "ChatRoom", matchId: data.matchId },
        });
        break;

      case "new_message":
        await sendPush(userId, {
          title: `${data.senderName}`,
          body: data.preview,
          data: { screen: "ChatRoom", matchId: data.matchId },
        });
        break;

      case "message_deadline":
        await sendPush(userId, {
          title: "⏰ 메시지 타이머",
          body: "매칭이 3시간 뒤 만료돼요. 지금 메시지를 보내세요!",
          data: { screen: "ChatRoom", matchId: data.matchId },
        });
        break;

      default:
        console.warn(`Unknown notification type: ${type}`);
    }
  }
};

async function sendPush(userId, payload) {
  // TODO: 사용자의 FCM/APNs 토큰 조회 → 실제 푸시 전송
  // FCM: firebase-admin SDK
  // APNs: @aws-sdk/client-sns (Platform Application)

  console.log(`[PUSH] userId=${userId}`, payload);

  // 실제 구현 시:
  // 1. DynamoDB에서 userId의 deviceToken 조회
  // 2. FCM HTTP v1 API 호출 또는 SNS Platform Endpoint 사용
}
