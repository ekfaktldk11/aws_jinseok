import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, ok, badRequest, serverError } from "./shared.js";

const VENUE_CACHE_TABLE = process.env.VENUE_CACHE_TABLE;
const KAKAO_MAP_API_KEY = process.env.KAKAO_MAP_API_KEY;

function getCategoryLabel(groupName, fullName) {
  if (groupName === "카페") return "카페";
  if (fullName.includes("술집") || fullName.includes("바")) return "바";
  if (groupName === "음식점") return "식당";
  return "기타";
}

export const handler = async (event) => {
  const method = event.httpMethod;
  const path = event.resource;

  try {
    // POST /venues/nearby
    if (method === "POST" && path === "/venues/nearby") {
      const body = JSON.parse(event.body);
      const { lat, lng, radius = 500, category } = body;

      if (!lat || !lng) return badRequest("위치 정보가 필요해요");

      const venues = [];
      const categories = category ? [category] : ["CE7", "FD6"];

      for (const code of categories) {
        const params = new URLSearchParams({
          category_group_code: code,
          x: String(lng),
          y: String(lat),
          radius: String(radius),
          sort: "distance",
          size: "15",
        });

        const response = await fetch(
          `https://dapi.kakao.com/v2/local/search/category.json?${params}`,
          { headers: { Authorization: `KakaoAK ${KAKAO_MAP_API_KEY}` } }
        );

        if (!response.ok) {
          console.error(`Kakao API error: ${response.status}`);
          continue;
        }

        const data = await response.json();

        for (const place of data.documents) {
          const venue = {
            venueId: place.id,
            name: place.place_name,
            category: getCategoryLabel(place.category_group_name, place.category_name),
            address: place.road_address_name || place.address_name,
            lat: parseFloat(place.y),
            lng: parseFloat(place.x),
            distance: parseInt(place.distance),
          };

          venues.push(venue);

          await ddb.send(new PutCommand({
            TableName: VENUE_CACHE_TABLE,
            Item: {
              ...venue,
              expiresAt: Math.floor(Date.now() / 1000) + 86400,
              cachedAt: new Date().toISOString(),
            },
          }));
        }
      }

      const unique = venues.filter(
        (v, i, arr) => arr.findIndex((a) => a.venueId === v.venueId) === i
      );
      unique.sort((a, b) => a.distance - b.distance);

      return ok({ venues: unique, count: unique.length });
    }

    // GET /venues/{venueId}
    if (method === "GET" && path === "/venues/{venueId}") {
      const { venueId } = event.pathParameters;
      const result = await ddb.send(new GetCommand({
        TableName: VENUE_CACHE_TABLE,
        Key: { venueId },
      }));

      if (!result.Item) return ok({ venue: null });
      return ok({ venue: result.Item });
    }

    return badRequest("지원하지 않는 요청이에요");
  } catch (err) {
    console.error("Venue Lambda Error:", err);
    return serverError();
  }
};
