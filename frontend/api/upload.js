// /api/upload.js

import formidable from 'formidable-serverless';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import Tesseract from 'tesseract.js';
import XLSX from 'xlsx';
import stringSimilarity from 'string-similarity';

// CORS 및 bodyParser 설정
export const config = {
  api: {
    bodyParser: false, // Next.js 기본 파서 비활성화
  },
};

//-------------------------------------------
// 1) 이미지 전처리 (흑백 변환 + threshold 적용)
//-------------------------------------------
async function preprocessImage(inputPath, outputPath) {
  await sharp(inputPath)
    .grayscale()
    .threshold(200)
    .toFile(outputPath);
}

//-------------------------------------------
// 2) Tesseract.js를 이용한 OCR 수행
//-------------------------------------------
async function performOCR(imagePath) {
  try {
    const processedPath = imagePath.replace(/(\.[^.]+)$/, '_processed$1');
    await preprocessImage(imagePath, processedPath);

    const { data: { text } } = await Tesseract.recognize(processedPath, 'eng+kor', {
      logger: m => console.log("🔍 OCR 진행:", m)
    });
    console.log("🔥 OCR 결과:\n", text);
    return text;
  } catch (err) {
    console.error("❌ OCR 실패:", err);
    return '';
  }
}

//-------------------------------------------
// 3) 문자열 정규화 및 숫자 추출 헬퍼 함수
//-------------------------------------------
function normalizeStr(str) {
  return str
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .trim();
}

function extractDigits(str) {
  const digits = str.replace(/\D/g, '');
  return digits || '0';
}

// 콤마나 슬래시로 구분되는 부분 처리 (예: "HEX SOCKET HEAD BOLT/SW/PW,NUT")
const nameReplacements = {
  'HEX SOCKET HEAD BOLT': 'HEX BOLT',
  'SW': 'SW (SPRING WASHER)',
  'PW': 'PW (PLAIN WASHER)',
  'NUT': 'NUT',
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

//-------------------------------------------
// 4) OCR 결과 텍스트를 행 단위로 파싱하여 아이템 배열로 변환
//-------------------------------------------
function parseOCRTextToItems(fullText) {
  const lines = fullText
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  // 표 헤더나 무시할 키워드가 있는 줄은 제거
  const filtered = lines.filter(line => {
    const lower = line.toLowerCase();
    if (
      (lower.includes('명칭') && lower.includes('재료') && lower.includes('수량') && lower.includes('규격')) ||
      lower.includes('순번') ||
      lower.includes('p.no') ||
      lower.includes('비고') ||
      lower.includes('remarks')
    ) {
      return false;
    }
    return true;
  });

  const parsed = [];
  for (let line of filtered) {
    const parts = line.split(/\s+/);
    if (parts.length < 4) {
      // 토큰 부족으로 파싱 실패
      parsed.push({
        parseError: true,
        reason: '토큰부족',
        rawLine: line,
      });
      continue;
    }

    const [rawName, rawMaterial, rawQty, ...rest] = parts;
    const rawSpec = rest.join(' ');
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

//-------------------------------------------
// 5) 엑셀 파일 로딩 (mydata.xlsx 파일 경로 수정)
//     → 여기서는 mydata.xlsx 파일을 /api 폴더 내에 두었다고 가정합니다.
//-------------------------------------------
let multiSheetData = [];
try {
  const excelPath = path.join(process.cwd(), 'api', 'mydata.xlsx'); // mydata.xlsx 파일은 /api 폴더 내에 있어야 합니다.
  if (!fs.existsSync(excelPath)) {
    console.error("❌ 엑셀 파일이 존재하지 않습니다:", excelPath);
  } else {
    const workbook = XLSX.readFile(excelPath);
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
  }
} catch (err) {
  console.error("❌ 엑셀 로딩 실패:", err);
}

//-------------------------------------------
// 6) OCR 아이템과 엑셀 행의 유사도 계산 및 매칭
//-------------------------------------------
function computeScore(ocrItem, rowData) {
  const rowString = `
    ${rowData['자재명'] || ''}
    ${rowData['재질'] || ''}
    ${rowData['사양/타입'] || ''}
    ${rowData['용량/사이즈'] || ''}
    ${rowData['상세규격'] || ''}
    ${rowData['품번'] || ''}
  `;
  const rowNorm = normalizeStr(rowString);
  const ocrNorm = normalizeStr(`${ocrItem.name} ${ocrItem.material} ${ocrItem.spec}`);

  return stringSimilarity.compareTwoStrings(ocrNorm, rowNorm);
}

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
  if (best.score < 0.40) return null; // 유사도 40% 미만은 매칭 실패 처리
  return best;
}

//-------------------------------------------
// 7) 서버리스 함수 핸들러 (CORS 처리 포함)
//-------------------------------------------
export default async function handler(req, res) {
  // 모든 응답에 CORS 헤더 추가
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // OPTIONS 요청이면 바로 200 응답
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // POST 요청이 아니면 405 오류 반환
  if (req.method !== 'POST') {
    return res.status(405).json({ message: "Method not allowed. Use POST." });
  }

  // formidable을 사용하여 multipart/form-data 파싱
  const form = new formidable.IncomingForm({
    uploadDir: path.join(process.cwd(), 'temp'), // 업로드 임시 폴더 (존재하는지 확인하세요)
    keepExtensions: true,
    maxFileSize: 20 * 1024 * 1024, // 20MB 제한
  });

  form.parse(req, async (err, fields, files) => {
    if (err) {
      console.error("폼 파싱 에러:", err);
      return res.status(500).json({ error: "업로드 파싱 에러" });
    }

    // "image" 필드에 파일이 있는지 확인
    const uploadedFile = files.image;
    if (!uploadedFile) {
      return res.status(400).json({ error: "image 필드가 없습니다." });
    }

    const imagePath = uploadedFile.path; // 업로드된 파일의 임시 경로

    try {
      // 1) OCR 수행
      const text = await performOCR(imagePath);

      // 2) OCR 결과 파싱하여 아이템 배열 생성
      const parsedItems = parseOCRTextToItems(text);

      // 3) OCR 아이템과 엑셀 데이터를 기반으로 매칭 작업
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
            reason: `파싱 오류(${item.reason})`
          });
          return;
        }

        const best = findBestMatch(item);
        if (!best) {
          // 매칭 실패 (유사도 40% 미만)
          unmatchedItems.push({
            seq,
            name: item.name,
            spec: item.spec,
            quantity: item.quantity,
            reason: "매칭률 40% 미만"
          });
        } else {
          // 매칭 성공
          const pn = best.rowData['품번'] || "(품번없음)";
          const matchRate = (best.score * 100).toFixed(0) + '%';
          matchedItems.push({
            seq,
            pn,
            name: item.name,
            spec: item.spec,
            quantity: item.quantity,
            matchRate
          });
        }
      });

      // 임시 이미지 파일 삭제
      fs.unlink(imagePath, err => {
        if (err) console.log("임시 파일 삭제 에러:", err);
      });

      return res.status(200).json({ matchedItems, unmatchedItems });

    } catch (e) {
      console.error("❌ 서버 내부 에러:", e);
      return res.status(500).json({ error: "서버 내부 오류" });
    }
  });
}
