import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.USERS_TABLE;

export const handler = async (event) => {
  // 비밀번호 재설정 확인은 유저 생성 불필요
  if (event.triggerSource !== "PostConfirmation_ConfirmSignUp") {
    return event;
  }

  const { sub, email, name, picture } = event.request.userAttributes;

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
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      ConditionExpression: "attribute_not_exists(userId)",
    }));

    console.log(`User created: ${sub} (${email})`);
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      console.log(`User already exists: ${sub}`);
    } else {
      console.error("PostConfirmation failed:", err);
      throw err;
    }
  }

  return event;
};
