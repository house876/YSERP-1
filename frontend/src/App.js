// frontend/src/App.js

import React, { useState } from "react";
import axios from "axios";
import "bootstrap/dist/css/bootstrap.min.css";

function App() {
  const [image, setImage] = useState(null);
  const [preview, setPreview] = useState(null);

  const [matchedItems, setMatchedItems] = useState([]);
  const [unmatchedItems, setUnmatchedItems] = useState([]);

  // 파일 변경
  const handleFileChange = (e) => {
    const file = e.target.files[0];
    setImage(file);
    if (file) {
      setPreview(URL.createObjectURL(file));
    }
  };

  // 업로드 & OCR
  const handleUpload = async () => {
    if (!image) {
      alert("이미지를 선택하세요!");
      return;
    }
    const formData = new FormData();
    formData.append("image", image);

    try {
      // ★ 수정: localhost:3001 -> /api/upload
      const res = await axios.post("/api/upload", formData, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      setMatchedItems(res.data.matchedItems || []);
      setUnmatchedItems(res.data.unmatchedItems || []);
    } catch (err) {
      alert("업로드 중 에러: " + err);
    }
  };

  return (
    <div className="container mt-5">
      <h2>윤성 구매품 품번박사 🧓</h2>

      <div className="mb-3">
        <input type="file" accept="image/*" onChange={handleFileChange} />
      </div>

      {preview && (
        <div className="mb-3">
          <img
            src={preview}
            alt="preview"
            style={{ maxWidth: "300px", border: "1px solid #ccc" }}
          />
        </div>
      )}

      <button className="btn btn-primary mb-4" onClick={handleUpload}>
        업로드 & OCR
      </button>

      {/* 매칭된 품목 */}
      {matchedItems.length > 0 && (
        <div className="mb-3">
          <h4>매칭된 품목</h4>
          <table className="table table-bordered">
            <thead>
              <tr>
                <th>순번</th>
                <th>품번</th>
                <th>명칭</th>
                <th>규격</th>
                <th>수량</th>
                <th>매칭률</th>
              </tr>
            </thead>
            <tbody>
              {matchedItems.map((item, idx) => (
                <tr key={idx}>
                  <td>{item.seq}</td>
                  <td>{item.pn}</td>
                  <td>{item.name}</td>
                  <td>{item.spec}</td>
                  <td>{item.quantity}</td>
                  <td>{item.matchRate}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 매칭 실패 품목 */}
      {unmatchedItems.length > 0 && (
        <div>
          <h4>매칭 실패 품목</h4>
          <table className="table table-bordered">
            <thead>
              <tr>
                <th>순번</th>
                <th>명칭</th>
                <th>규격</th>
                <th>수량</th>
                <th>못찾은 이유</th>
              </tr>
            </thead>
            <tbody>
              {unmatchedItems.map((item, idx) => (
                <tr key={idx}>
                  <td>{item.seq}</td>
                  <td>{item.name}</td>
                  <td>{item.spec}</td>
                  <td>{item.quantity}</td>
                  <td>{item.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default App;
