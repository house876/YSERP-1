// api/upload.js

import formidable from "formidable-serverless";
import fs from "fs";
import path from "path";
import sharp from "sharp";
import Tesseract from "tesseract.js";
import XLSX from "xlsx";
import stringSimilarity from "string-similarity";

// Vercel 서버리스 함수에서는 기본 파서 사용하지 않으므로 아래 설정
export const config = {
  api: {
    bodyParser: false,
  },
};

// 1. 이미지 전처리 (흑백 변환 + 임계값 처리)
async function preprocessImage(inputPath, outputPath) {
  await sharp(inputPath)
    .grayscale()
    .threshold(200)
    .toFile(outputPath);
}

// 2. Tesseract OCR 처리 함수
async function performOCR(imagePath) {
  try {
    const processedPath = imagePath.replace(/(\.[^.]+)$/, "_processed$1");
    await preprocessImage(imagePath, processedPath);
    const { data: { text } } = await Tesseract.recognize(processedPath, "eng+kor", {
      logger: m => console.log("🔍 OCR 진행:", m)
    });
    console.log("🔥 OCR 결과:\n", text);
    return text;
  } catch (err) {
    console.error("❌ OCR 실패:", err);
    return "";
  }
}

// 3. 텍스트 정규화 함수 (유사도 비교를 위해)
function normalizeStr(str) {
  return str.toUpperCase().replace(/[^A-Z0-9]/g, "").trim();
}

// 4. 수량에서 숫자만 추출 (예: "3EA" → "3")
function extractDigits(str) {
  const digits = str.replace(/\D/g, "");
  return digits || "0";
}

// 5. 명칭에 콤마나 슬래시가 있을 때 개별 아이템으로 분리
const nameReplacements = {
  "HEX SOCKET HEAD BOLT": "HEX BOLT",
  SW: "SW (SPRING WASHER)",
  PW: "PW (PLAIN WASHER)",
  NUT: "NUT",
};
function expandNameSubitems(name, material, quantity, spec) {
  const tokens = name.split(/[,/]+/);
  const results = [];
  tokens.forEach(tok => {
    const trimmed = tok.trim();
    if (!trimmed) return;
    const upper = trimmed.toUpperCase();
    if (nameReplacements[upper]) {
      results.push({ name: nameReplacements[upper], material, quantity, spec });
    } else {
      results.push({ name: trimmed, material, quantity, spec });
    }
  });
  return results;
}

// 6. OCR 텍스트를 읽어서 각 행별 아이템으로 분리
function parseOCRTextToItems(fullText) {
  const lines = fullText
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean);
  
  // 표의 헤더(예: "명칭 재료 수량 규격", "순번" 등)는 무시합니다.
  const filtered = lines.filter(line => {
    const lower = line.toLowerCase();
    if (
      (lower.includes("명칭") && lower.includes("재료") && lower.includes("수량") && lower.includes("규격")) ||
      lower.includes("순번") ||
      lower.includes("p.no") ||
      lower.includes("비고") ||
      lower.includes("remarks")
    ) {
      return false;
    }
    return true;
  });

  const parsed = [];
  for (let line of filtered) {
    const parts = line.split(/\s+/);
    if (parts.length < 4) {
      parsed.push({
        parseError: true,
        reason: "토큰부족",
        rawLine: line,
      });
      continue;
    }
    const [rawName, rawMaterial, rawQty, ...rest] = parts;
    const rawSpec = rest.join(" ");
    const quantity = extractDigits(rawQty);
    const subitems = expandNameSubitems(rawName, rawMaterial, quantity, rawSpec);
    subitems.forEach(si => {
      parsed.push({
        parseError: false,
        name: si.name,
        material: si.material,
        quantity: si.quantity,
        spec: si.spec,
      });
    });
  }
  return parsed;
}

// 7. 엑셀 파일 읽어오기 (엑셀 파일은 api 폴더에 위치한다고 가정)
let multiSheetData = [];
try {
  const workbook = XLSX.readFile(path.join(process.cwd(), "mydata.xlsx"));
  const sheetNames = workbook.SheetNames;
  sheetNames.forEach(sheetName => {
    const ws = workbook.Sheets[sheetName];
    const jsonData = XLSX.utils.sheet_to_json(ws);
    multiSheetData.push({
      sheetName,
      data: jsonData
    });
  });
  console.log("✅ 엑셀 로딩 완료:", multiSheetData.length, "개 시트");
} catch (err) {
  console.error("❌ 엑셀 로딩 실패:", err);
}

// 8. OCR 아이템과 엑셀 데이터를 비교하여 유사도 계산
function computeScore(ocrItem, rowData) {
  const rowString = `
    ${rowData["자재명"] || ""}
    ${rowData["재질"] || ""}
    ${rowData["사양/타입"] || ""}
    ${rowData["용량/사이즈"] || ""}
    ${rowData["상세규격"] || ""}
    ${rowData["품번"] || ""}
  `;
  const rowNorm = normalizeStr(rowString);
  const ocrNorm = normalizeStr(`${ocrItem.name} ${ocrItem.material} ${ocrItem.spec}`);
  return stringSimilarity.compareTwoStrings(ocrNorm, rowNorm);
}

// 9. 최고 매칭 찾기 (유사도 40% 미만이면 실패)
function findBestMatch(ocrItem) {
  let best = { sheetName: null, rowData: null, score: 0 };
  for (let sheetObj of multiSheetData) {
    for (let row of sheetObj.data) {
      const score = computeScore(ocrItem, row);
      if (score > best.score) {
        best = { sheetName: sheetObj.sheetName, rowData: row, score };
      }
    }
  }
  if (best.score < 0.40) return null;
  return best;
}

// 10. 서버리스 함수 (핸들러) - GET과 POST 모두 처리
export default async function handler(req, res) {
  // 만약 GET 요청이면, 업로드 테스트를 위한 간단한 HTML 폼을 보여줍니다.
  if (req.method === "GET") {
    res.setHeader("Content-Type", "text/html");
    return res.status(200).send(`
      <html>
        <body>
          <h1>파일 업로드 테스트</h1>
          <form method="POST" enctype="multipart/form-data">
            <input type="file" name="image" /><br/><br/>
            <button type="submit">업로드</button>
          </form>
        </body>
      </html>
    `);
  }

  // POST 요청일 경우에만 파일 업로드 및 처리 수행
  if (req.method === "POST") {
    const form = new formidable.IncomingForm({
      uploadDir: path.join(process.cwd(), "temp"),
      keepExtensions: true,
      maxFileSize: 20 * 1024 * 1024, // 20MB 제한
    });

    form.parse(req, async (err, fields, files) => {
      if (err) {
        console.error("폼 파싱 에러:", err);
        return res.status(500).json({ error: "업로드 파싱 에러" });
      }

      const uploadedFile = files.image;
      if (!uploadedFile) {
        return res.status(400).json({ error: "image 필드가 없습니다." });
      }

      const imagePath = uploadedFile.path;
      try {
        // OCR 수행
        const text = await performOCR(imagePath);
        // OCR 텍스트 파싱
        const parsedItems = parseOCRTextToItems(text);
        // 매칭 결과 분류
        const matchedItems = [];
        const unmatchedItems = [];
        parsedItems.forEach((item, idx) => {
          const seq = idx + 1;
          if (item.parseError) {
            unmatchedItems.push({
              seq,
              name: item.rawLine,
              spec: "-",
              quantity: "-",
              reason: `파싱 오류(${item.reason})`,
            });
            return;
          }
          const best = findBestMatch(item);
          if (!best) {
            unmatchedItems.push({
              seq,
              name: item.name,
              spec: item.spec,
              quantity: item.quantity,
              reason: "매칭률 40% 미만",
            });
          } else {
            const pn = best.rowData["품번"] || "(품번없음)";
            const matchRate = (best.score * 100).toFixed(0) + "%";
            matchedItems.push({
              seq,
              pn,
              name: item.name,
              spec: item.spec,
              quantity: item.quantity,
              matchRate,
            });
          }
        });

        // 임시 파일 삭제
        fs.unlink(imagePath, err => {
          if (err) console.log("임시 파일 삭제 에러:", err);
        });

        return res.status(200).json({ matchedItems, unmatchedItems });
      } catch (e) {
        console.error("❌ 서버 내부 에러:", e);
        return res.status(500).json({ error: "서버 내부 오류" });
      }
    });
  } else {
    // 다른 HTTP 메소드(GET, POST 이외)는 여기서 모두 처리합니다.
    return res.status(405).json({ message: "허용되지 않은 요청입니다." });
  }
}
