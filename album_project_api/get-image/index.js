const { S3Client, ListObjectsCommand, GetObjectCommand } = require("@aws-sdk/client-s3");

// 특정 파일 가져오기
const getObject = async (client, Key) => {
    const command = new GetObjectCommand({ Bucket: process.env.SOURCE_BUCKET, Key });

    return await client.send(command);
};

// ByteArrayUrl 형태로 변경
// const transformToByteArrayUrl = async (imageData) => {
//     const result = await imageData.transformToByteArray();

//     const imageBuffer = Buffer.from(result);

//     return `data:image/jpeg;base64,${imageBuffer.toString("base64")}`;
// };

// 가장 최신 이미지 Key 값 불러오기
const getImageContents = async (client) => {
    const command = new ListObjectsCommand({ Bucket: process.env.SOURCE_BUCKET });

    const response = await client.send(command);

    return response?.Contents;
};

exports.handler = async function (event, context) {
    try {
        console.log("## event : ", event);

        const s3Client = new S3Client();
        const contents = await getImageContents(s3Client);

        console.log("## contents : ", contents);
        // let idx = 0;
        // for (const content of contents) {
        //     console.log(`## content #${idx} : `, content);
        //     idx++;
        // }
        // // const imageObj = await getObject(s3Client, Key);
        // const imageUrl = await transformToByteArrayUrl(imageObj.Body);
        // console.log("## imageObj : ", imageObj);

    } catch (err) {
        console.error(err);
    }

    return {
        statusCode: 200,
    };
};