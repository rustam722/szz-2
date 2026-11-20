// ═══════════════════════════════════════════════════════════════════════════
//  Источники шума → INT (Эколог-Шум)
//  ---------------------------------------------------------------------------
//  Перенесено из отдельного инструмента конвертер.html (Desktop\noise_converter).
//  Табличный ввод источников шума (название/координаты/высота/октавные уровни
//  31.5–8000 Гц/La/Lamax/Omega) → файл импорта формата Эколог-Шум (.int).
//  Полностью клиентский инструмент, сервер не нужен.
//
//  Изменения при переносе:
//   • Разметка строится один раз при первом входе в режим (enterNoiseMode),
//     по образцу enterRiskMode()/enterPdfMode().
//   • alert()/confirm() заменены на askNotice()/askConfirm() приложения —
//     системные диалоги не подчиняются теме и блокируют всё окно целиком.
//   • Скачивание .int идёт через _download() из export.js — под pywebview
//     обычный a.click() заблокирован (та же причина, что и в risk.js).
//   • Document-level paste (вставка из Excel) теперь активна только пока
//     открыт этот режим — иначе вставка в любом другом месте приложения
//     молча добавляла бы сюда строки.
// ═══════════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  // ══════════════════════════════════════════════════════════════════════════
  //  cp1251 ⇄ UTF-16 (шаблон и экспорт хранятся в cp1251 — так ждёт Эколог-Шум)
  // ══════════════════════════════════════════════════════════════════════════
  const C81 = [
    0x0402,0x0403,0x201A,0x0453,0x201E,0x2026,0x2020,0x2021,
    0x20AC,0x2030,0x0409,0x2039,0x040A,0x040C,0x040B,0x040F,
    0x0452,0x2018,0x2019,0x201C,0x201D,0x2022,0x2013,0x2014,
    0x0098,0x2122,0x0459,0x203A,0x045A,0x045C,0x045B,0x045F,
    0x00A0,0x040E,0x045E,0x0408,0x00A4,0x0490,0x00A6,0x00A7,
    0x0401,0x00A9,0x0404,0x00AB,0x00AC,0x00AD,0x00AE,0x0407,
    0x00B0,0x00B1,0x0406,0x0456,0x0491,0x00B5,0x00B6,0x00B7,
    0x0451,0x2116,0x0454,0x00BB,0x0458,0x0405,0x0455,0x0457
  ];
  const REV = new Map();
  for (let i = 0; i < 0x80; i++) REV.set(i, i);
  for (let i = 0; i < 64; i++) REV.set(C81[i], 0x80 + i);
  for (let i = 0; i < 64; i++) REV.set(0x0410 + i, 0xC0 + i);

  function b2s(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      if (b < 0x80) s += String.fromCharCode(b);
      else if (b < 0xC0) s += String.fromCharCode(C81[b - 0x80]);
      else s += String.fromCharCode(0x0410 + (b - 0xC0));
    }
    return s;
  }
  function s2b(str) {
    const out = [];
    for (const ch of str) {
      const c = ch.charCodeAt(0);
      if (c < 0x80) out.push(c);
      else if (REV.has(c)) out.push(REV.get(c));
      else out.push(0x3F);
    }
    return new Uint8Array(out);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Шаблон .int (встроенный base64) — заголовок/подвал файла обмена
  //  Эколог-Шум берутся из реального экспорта программы, строки источников
  //  вставляются между [emNoiseSource] и [META_emNoiseObstacle].
  // ══════════════════════════════════════════════════════════════════════════
  const TPL_B64 = "W1dJTl0NCltNRVRBX2VtTm9pc2VTb3VyY2VdDQoxLDIsIlIiLCLE6PHy4O326P8g5+Ds5fDgICjw4PH3uPLgKSwg7CIsIsTo8fLg7fbo/yDn4Ozl8OAgKPDg8fe48uApIiwixOjx8uDt9uj/LCDk6/8g6u7y7vDu6SDz6uDn4O37IP3q4uji4Ovl7fLt++Ug08fELCBMYS796uIg6CBMYS7s4Orxz/DoIOjx7+7r/Ofu4uDt6Ogg08fMIC0g5+3g9+Xt6OUg7eUg8+rg5/vi4OXy8f8gIiwyLDAuMCwiXFxkezEsfShbXFxSLl17MCwxfVxcZHswLDJ9KXswLDF9IiwxLDgwLDA7DQoyLDIsImYzMTUiLCIzMSw1IiwsIt3q4uji4Ovl7fLt++kg08fEIOIg7ury4OLt7ukg7+7r7vHlIPHuIPHw5eTt5ePl7uzl8vDo9+Xx6u7pIPfg8fLu8u7pIDMxLjXD9iIsMywwLjAwLCJbLV17MCwxfVxcZHsxLH0oW1xcUi5dezAsMX1cXGR7MCwyfSl7MCwxfSIsMSw0MCwtMjAwLDIwMCwi0/Du4u3oIOfi8+ru4u7j7iDk4OLr5e3o/ywg5MEsIOIg7ury4OLt+/Ug7+7r7vHg9SDxINHD1yDiIMP2IjsNCjMsMiwiZjYzIiw2MywsIt3q4uji4Ovl7fLt++kg08fEIOIg7ury4OLt7ukg7+7r7vHlIPHuIPHw5eTt5ePl7uzl8vDo9+Xx6u7pIPfg8fLu8u7pIDYzw/YiLDQsMC4wMCwiWy1dezAsMX1cXGR7MSx9KFtcXFIuXXswLDF9XFxkezAsMn0pezAsMX0iLDEsNDAsLTIwMCwyMDAsItPw7uLt6CDn4vPq7uLu4+4g5ODi6+Xt6P8sIOTBLCDiIO7q8uDi7fv1IO/u6+7x4PUg8SDRw9cg4iDD9iI7DQo0LDIsImYxMjUiLDEyNSwsIt3q4uji4Ovl7fLt++kg08fEIOIg7ury4OLt7ukg7+7r7vHlIPHuIPHw5eTt5ePl7uzl8vDo9+Xx6u7pIPfg8fLu8u7pIDEyNcP2Iiw1LDAuMDAsIlstXXswLDF9XFxkezEsfShbXFxSLl17MCwxfVxcZHswLDJ9KXswLDF9IiwxLDQwLC0yMDAsMjAwLCLT8O7i7egg5+Lz6u7i7uPuIOTg4uvl7ej/LCDkwSwg4iDu6vLg4u379SDv7uvu8eD1IPEg0cPXIOIgw/YiOw0KNSwyLCJmMjUwIiwyNTAsLCLd6uLo4uDr5e3y7fvpINPHxCDiIO7q8uDi7e7pIO/u6+7x5SDx7iDx8OXk7eXj5e7s5fLw6Pfl8eru6SD34PHy7vLu6SAyNTDD9iIsNiwwLjAwLCJbLV17MCwxfVxcZHsxLH0oW1xcUi5dezAsMX1cXGR7MCwyfSl7MCwxfSIsMSw0MCwtMjAwLDIwMCwi0/Du4u3oIOfi8+ru4u7j7iDk4OLr5e3o/ywg5MEsIOIg7ury4OLt+/Ug7+7r7vHg9SDxINHD1yDiIMP2IjsNCjYsMiwiZjUwMCIsNTAwLCwi3eri6OLg6+Xt8u376SDTx8Qg4iDu6vLg4u3u6SDv7uvu8eUg8e4g8fDl5O3l4+Xu7OXy8Oj35fHq7ukg9+Dx8u7y7ukgNTAww/YiLDcsMC4wMCwiWy1dezAsMX1cXGR7MSx9KFtcXFIuXXswLDF9XFxkezAsMn0pezAsMX0iLDEsNDAsLTIwMCwyMDAsItPw7uLt6CDn4vPq7uLu4+4g5ODi6+Xt6P8sIOTBLCDiIO7q8uDi7fv1IO/u6+7x4PUg8SDRw9cg4iDD9iI7DQo3LDIsImYxMDAwIiwxMDAwLCwi3eri6OLg6+Xt8u376SDTx8Qg4iDu6vLg4u3u6SDv7uvu8eUg8e4g8fDl5O3l4+Xu7OXy8Oj35fHq7ukg9+Dx8u7y7ukgMTAwMMP2Iiw4LDAuMDAsIlstXXswLDF9XFxkezEsfShbXFxSLl17MCwxfVxcZHswLDJ9KXswLDF9IiwxLDQwLC0yMDAsMjAwLCLT8O7i7egg5+Lz6u7i7uPuIOTg4uvl7ej/LCDkwSwg4iDu6vLg4u379SDv7uvu8eD1IPEg0cPXIOIgw/YiOw0KOCwyLCJmMjAwMCIsMjAwMCwsIt3q4uji4Ovl7fLt++kg08fEIOIg7ury4OLt7ukg7+7r7vHlIPHuIPHw5eTt5ePl7uzl8vDo9+Xx6u7pIPfg8fLu8u7pIDIwMDDD9iIsOSwwLjAwLCJbLV17MCwxfVxcZHsxLH0oW1xcUi5dezAsMX1cXGR7MCwyfSl7MCwxfSIsMSw0MCwtMjAwLDIwMCwi0/Du4u3oIOfi8+ru4u7j7iDk4OLr5e3o/ywg5MEsIOIg7ury4OLt+/Ug7+7r7vHg9SDxINHD1yDiIMP2IjsNCjksMiwiZjQwMDAiLDQwMDAsLCLd6uLo4uDr5e3y7fvpINPHxCDiIO7q8uDi7e7pIO/u6+7x5SDx7iDx8OXk7eXj5e7s5fLw6Pfl8eru6SD34PHy7vLu6SA0MDAww/YiLDEwLDAuMDAsIlstXXswLDF9XFxkezEsfShbXFxSLl17MCwxfVxcZHswLDJ9KXswLDF9IiwxLDQwLC0yMDAsMjAwLCLT8O7i7egg5+Lz6u7i7uPuIOTg4uvl7ej/LCDkwSwg4iDu6vLg4u379SDv7uvu8eD1IPEg0cPXIOIgw/YiOw0KMTAsMiwiZjgwMDAiLDgwMDAsLCLd6uLo4uDr5e3y7fvpINPHxCDiIO7q8uDi7e7pIO/u6+7x5SDx7iDx8OXk7eXj5e7s5fLw6Pfl8eru6SD34PHy7vLu6SA4MDAww/YiLDExLDAuMDAsIlstXXswLDF9XFxkezEsfShbXFxSLl17MCwxfVxcZHswLDJ9KXswLDF9IiwxLDQwLC0yMDAsMjAwLCLT8O7i7egg5+Lz6u7i7uPuIOTg4uvl7ej/LCDkwSwg4iDu6vLg4u379SDv7uvu8eD1IPEg0cPXIOIgw/YiOw0KMTEsMiwiZkxhIiwiTGEu/eriIiwsIt3q4uji4Ovl7fLt++kg8/Du4uXt/CDn4vPq4CIsMTIsMC4wMCwiWy1dezAsMX1cXGR7MSx9KFtcXFIuXXswLDF9XFxkezAsMn0pezAsMX0iLDEsNDAsLTIwMCwyMDA7DQoxNCwxLCJTb3VyY2VUeXBlIiwi0ujvIOjx8u737ejq4CIsLCwxMywsLDEsMTE1LDAsMSwi0/fl8iDt5e/u8fLu/+3t7uPuIPjz7OAiOw0KMTUsMiwiVHdvcmsiLCLyIiwsIsLw5ez/IPDg4e7y+yDo8fLu9+3o6uAg4iDw4Ozq4PUg7uH55ePuIOLw5ezl7egg4u7n5OXp8fLi6P8gVCIsMTQsMC4wLCJcXGR7MSx9KFtcXFIuXXswLDF9XFxkezAsMX0pezAsMX0iLDEsMzUsMCwxNDQwLCLT9+XyIO3l7+7x8u7/7e3u4+4g+PPs4CI7DQoxNiwyLCJUbWVhc3VyaW5nIiwiVCIsLCLO4fnl5SDi8OXs/yDi7ufk5enx8uLo/yIsMTUsMC4wLCJcXGR7MSx9KFtcXFIuXXswLDF9XFxkezAsMX0pezAsMX0iLDEsNDAsMCwxNDQwLCLT9+XyIO3l7+7x8u7/7e3u4+4g+PPs4CI7DQoxNywyLCJmTGFNYXgiLCJMYS7s4OrxIiwsIszg6vHo7ODr/O376SDz8O7i5e38IOfi8+rgIiwxNiwwLjAwLCJbLV17MCwxfVxcZHsxLH0oW1xcUi5dezAsMX1cXGR7MCwyfSl7MCwxfSIsMSw0NSwtMjAwLDIwMCwi0/fl8iDt5e/u8fLu/+3t7uPuIPjz7OAiOw0KMTgsMSwiTWF4U3BlY3RydW1UeXBlIiwix+Dy8/Vg7ejlIOzg6vHo7ODr/O3u4+4g+PPs4CIsLCwxNywsLDEsMTE1LDAsOSwi0/fl8iDt5e/u8fLu/+3t7uPuIPjz7OAiOw0KMTIsMiwiT21lZ2EiLCLP8O7x8vDg7fHy4uXt7fvpIPPj7ussIPDg5CIsLCwxOCwwLjAwLCJcXGR7MSx9KFtcXFIuXXswLDF9XFxkezAsMn0pezAsMX0iLDAsMTEwLDA7DQoxMywxLCJTaWRlcyIsIsjn6/P34P756OUg8fLu8O3+IiwsLDE5LCwsMCw4MDsNCltlbU5vaXNlU291cmNlXQ0KW2VtTm9pc2VTb3VyY2VdDQpbTUVUQV9lbU5vaXNlT2JzdGFjbGVdDQoxLDIsImEzMTUiLCIzMSw1IiwsLDMsMC4wMCwiXFxkezEsfShbXFxSLl17MCwxfVxcZHswLDJ9KXswLDF9IiwxLDQwLDAsMSwiyu799PTo9ujl7fIg5+Lz6u7v7uPr7vnl7ej/IOIg7ury4OLt+/Ug7+7r7vHg9SDxINHD1yDiIMP2IjsNCjIsMiwiYTYzIiw2MywsLDQsMC4wMCwiXFxkezEsfShbXFxSLl17MCwxfVxcZHswLDJ9KXswLDF9IiwxLDQwLDAsMSwiyu799PTo9ujl7fIg5+Lz6u7v7uPr7vnl7ej/IOIg7ury4OLt+/Ug7+7r7vHg9SDxINHD1yDiIMP2IjsNCjMsMiwiYTEyNSIsMTI1LCwsNSwwLjAwLCJcXGR7MSx9KFtcXFIuXXswLDF9XFxkezAsMn0pezAsMX0iLDEsNDAsMCwxLCLK7v309Oj26OXt8iDn4vPq7u/u4+vu+eXt6P8g4iDu6vLg4u379SDv7uvu8eD1IPEg0cPXIOIgw/YiOw0KNCwyLCJhMjUwIiwyNTAsLCw2LDAuMDAsIlxcZHsxLH0oW1xcUi5dezAsMX1cXGR7MCwyfSl7MCwxfSIsMSw0MCwwLDEsIsru/fT06Pbo5e3yIOfi8+ru7+7j6+755e3o/yDiIO7q8uDi7fv1IO/u6+7x4PUg8SDRw9cg4iDD9iI7DQo1LDIsImE1MDAiLDUwMCwsLDcsMC4wMCwiXFxkezEsfShbXFxSLl17MCwxfVxcZHswLDJ9KXswLDF9IiwxLDQwLDAsMSwiyu799PTo9ujl7fIg5+Lz6u7v7uPr7vnl7ej/IOIg7ury4OLt+/Ug7+7r7vHg9SDxINHD1yDiIMP2IjsNCjYsMiwiYTEwMDAiLDEwMDAsLCw4LDAuMDAsIlxcZHsxLH0oW1xcUi5dezAsMX1cXGR7MCwyfSl7MCwxfSIsMSw0MCwwLDEsIsru/fT06Pbo5e3yIOfi8+ru7+7j6+755e3o/yDiIO7q8uDi7fv1IO/u6+7x4PUg8SDRw9cg4iDD9iI7DQo3LDIsImEyMDAwIiwyMDAwLCwsOSwwLjAwLCJcXGR7MSx9KFtcXFIuXXswLDF9XFxkezAsMn0pezAsMX0iLDEsNDAsMCwxLCLK7v309Oj26OXt8iDn4vPq7u/u4+vu+eXt6P8g4iDu6vLg4u379SDv7uvu8eD1IPEg0cPXIOIgw/YiOw0KOCwyLCJhNDAwMCIsNDAwMCwsLDEwLDAuMDAsIlxcZHsxLH0oW1xcUi5dezAsMX1cXGR7MCwyfSl7MCwxfSIsMSw0MCwwLDEsIsru/fT06Pbo5e3yIOfi8+ru7+7j6+755e3o/yDiIO7q8uDi7fv1IO/u6+7x4PUg8SDRw9cg4iDD9iI7DQo5LDIsImE4MDAwIiw4MDAwLCwsMTEsMC4wMCwiXFxkezEsfShbXFxSLl17MCwxfVxcZHswLDJ9KXswLDF9IiwxLDQwLDAsMSwiyu799PTo9ujl7fIg5+Lz6u7v7uPr7vnl7ej/IOIg7ury4OLt+/Ug7+7r7vHg9SDxINHD1yDiIMP2IjsNCltlbU5vaXNlT2JzdGFjbGVdDQpbTUVUQV9lbU5vaXNlSXNvbGF0aW9uXQ0KMSwyLCJmMzE1IiwiMzEsNSIsLCwzLDAuMDAsIlxcZHsxLH0oW1xcUi5de zAsMX1cXGR7MCwyfSl7MCwxfSIsMSw0MCwwLDIwMCwix+Lz6u7o5+7r//bo/ywg5MEsIOIg7ury4OLt+/Ug7+7r7vHg9SDxINHD1yDiIMP2IjsNCjIsMiwiZjYzIiw2MywsLDQsMC4wMCwiXFxkezEsfShbXFxSLl17MCwxfVxcZHswLDJ9KXswLDF9IiwxLDQwLDAsMjAwLCLH4vPq7ujn7uv/9uj/LCDkwSwg4iDu6vLg4u379SDv7uvu8eD1IPEg0cPXIOIgw/YiOw0KMywyLCJmMTI1IiwxMjUsLCw1LDAuMDAsIlxcZHsxLH0oW1xcUi5dezAsMX1cXGR7MCwyfSl7MCwxfSIsMSw0MCwwLDIwMCwix+Lz6u7o5+7r//bo/ywg5MEsIOIg7ury4OLt+/Ug7+7r7vHg9SDxINHD1yDiIMP2IjsNCjQsMiwiZjI1MCIsMjUwLCwsNiwwLjAwLCJcXGR7MSx9KFtcXFIuXXswLDF9XFxkezAsMn0pezAsMX0iLDEsNDAsLDIwMCwix+Lz6u7o5+7r//bo/ywg5MEsIOIg7ury4OLt+/Ug7+7r7vHg9SDxINHD1yDiIMP2IjsNCjUsMiwiZjUwMCIsNTAwLCwsNywwLjAwLCJcXGR7MSx9KFtcXFIuXXswLDF9XFxkezAsMn0pezAsMX0iLDEsNDAsLDIwMCwix+Lz6u7o5+7r//bo/ywg5MEsIOIg7ury4OLt+/Ug7+7r7vHg9SDxINHD1yDiIMP2IjsNCjYsMiwiZjEwMDAiLDEwMDAsLCw4LDAuMDAsIlxcZHsxLH0oW1xcUi5dezAsMX1cXGR7MCwyfSl7MCwxfSIsMSw0MCwwLDIwMCwix+Lz6u7o5+7r//bo/ywg5MEsIOIg7ury4OLt+/Ug7+7r7vHg9SDxINHD1yDiIMP2IjsNCjcsMiwiZjIwMDAiLDIwMDAsLCw5LDAuMDAsIlxcZHsxLH0oW1xcUi5dezAsMX1cXGR7MCwyfSl7MCwxfSIsMSw0MCwwLDIwMCwix+Lz6u7o5+7r//bo/ywg5MEsIOIg7ury4OLt+/Ug7+7r7vHg9SDxINHD1yDiIMP2IjsNCjgsMiwiZjQwMDAiLDQwMDAsLCwxMCwwLjAwLCJcXGR7MSx9KFtcXFIuXXswLDF9XFxkezAsMn0pezAsMX0iLDEsNDAsLDIwMCwix+Lz6u7o5+7r//bo/ywg5MEsIOIg7ury4OLt+/Ug7+7r7vHg9SDxINHD1yDiIMP2IjsNCjksMiwiZjgwMDAiLDgwMDAsLCwxMSwwLjAwLCJcXGR7MSx9KFtcXFIuXXswLDF9XFxkezAsMn0pezAsMX0iLDEsNDAsLDIwMCwix+Lz6u7o5+7r//bo/ywg5MEsIOIg7ury4OLt+/Ug7+7r7vHg9SDxINHD1yDiIMP2IjsNCjEwLDQsIkNhcCIsIsrw+/jq4CIsLCwxMiwsLDEsNTA7DQoxMSw0LCJHcm91bmQiLCLE7e4iLCwsMTMsLCwxLDMwOw0KW2VtTm9pc2VJc29sYXRpb25dDQpbTUVUQV9lbU5vaXNlQWJzb3JwdGlvbl0NCjEsMiwiZjMxNSIsIjMxLDUiLCwsMywwLjAwLCJcXGR7MSx9KFtcXFIuXXswLDF9XFxkezAsMn0pezAsMX0iLDEsNDAsMCwyMDAsIsfi8+ru7+7j6+755e3o5SDu4frl6vLu7Cwg5MEv7Cwg4iDu6vLg4u379SDv7uvu8eD1IPEg0cPXIOIgw/YiOw0KMiwyLCJmNjMiLDYzLCwsNCwwLjAwLCJcXGR7MSx9KFtcXFIuXXswLDF9XFxkezAsMn0pezAsMX0iLDEsNDAsMCwyMDAsIsfi8+ru7+7j6+755e3o5SDu4frl6vLu7Cwg5MEv7Cwg4iDu6vLg4u379SDv7uvu8eD1IPEg0cPXIOIgw/YiOw0KMywyLCJmMTI1IiwxMjUsLCw1LDAuMDAsIlxcZHsxLH0oW1xcUi5dezAsMX1cXGR7MCwyfSl7MCwxfSIsMSw0MCwwLDIwMCwix+Lz6u7v7uPr7vnl7ejlIO7h+uXq8u7sLCDkwS/sLCDiIO7q8uDi7fv1IO/u6+7x4PUg8SDRw9cg4iDD9iI7DQo0LDIsImYyNTAiLDI1MCwsLDYsMC4wMCwiXFxkezEsfShbXFxSLl17MCwxfVxcZHswLDJ9KXswLDF9IiwxLDQwLDAsMjAwLCLH4vPq7u/u4+vu+eXt6OUg7uH65ery7uwsIOTBL+wsIOIg7ury4OLt+/Ug7+7r7vHg9SDxINHD1yDiIMP2IjsNCjUsMiwiZjUwMCIsNTAwLCwsNywwLjAwLCJcXGR7MSx9KFtcXFIuXXswLDF9XFxkezAsMn0pezAsMX0iLDEsNDAsMCwyMDAsIsfi8+ru7+7j6+755e3o5SDu4frl6vLu7Cwg5MEv7Cwg4iDu6vLg4u379SDv7uvu8eD1IPEg0cPXIOIgw/YiOw0KNiwyLCJmMTAwMCIsMTAwMCwsLDgsMC4wMCwiXFxkezEsfShbXFxSLl17MCwxfVxcZHswLDJ9KXswLDF9IiwxLDQwLDAsMjAwLCLH4vPq7u/u4+vu+eXt6OUg7uH65ery7uwsIOTBL+wsIOIg7ury4OLt+/Ug7+7r7vHg9SDxINHD1yDiIMP2IjsNCjcsMiwiZjIwMDAiLDIwMDAsLCw5LDAuMDAsIlxcZHsxLH0oW1xcUi5dezAsMX1cXGR7MCwyfSl7MCwxfSIsMSw0MCwwLDIwMCwix+Lz6u7v7uPr7vnl7ejlIO7h+uXq8u7sLCDkwS/sLCDiIO7q8uDi7fv1IO/u6+7x4PUg8SDRw9cg4iDD9iI7DQo4LDIsImY0MDAwIiw0MDAwLCwsMTAsMC4wMCwiXFxkezEsfShbXFxSLl17MCwxfVxcZHswLDJ9KXswLDF9IiwxLDQwLDAsMjAwLCLH4vPq7u/u4+vu+eXt6OUg7uH65ery7uwsIOTBL+wsIOIg7ury4OLt+/Ug7+7r7vHg9SDxINHD1yDiIMP2IjsNCjksMiwiZjgwMDAiLDgwMDAsLCwxMSwwLjAwLCJcXGR7MSx9KFtcXFIuXXswLDF9XFxkezAsMn0pezAsMX0iLDEsNDAsMCwyMDAsIsfi8+ru7+7j6+755e3o5SDu4frl6vLu7Cwg5MEv7Cwg4iDu6vLg4u379SDv7uvu8eD1IPEg0cPXIOIgw/YiOw0KW2VtTm9pc2VBYnNvcnB0aW9uXQ0KW01FVEFfZW1Ob2lzZUdyb3VuZF0NCjEsMiwiRyIsIsru/fT06Pbo5e3yIO7y8ODm5e3o/yDu8iDv7uLl8PXt7vHy6CDn5ezr6CIsLCwxLDAuMDAsIlxcZHsxLH0oW1xcUi5dezAsMX1cXGR7MCwyfSl7MCwxfSIsMSwzMDAsMCwxOw0KW2VtTm9pc2VHcm91bmRdDQpbTUVUQV9lbU5vaXNlUHJvbVpvbmVzXQ0KW2VtTm9pc2VQcm9tWm9uZXNdDQpbTUVUQV9lbU5vaXNlRm9saWFnZV0NCltlbU5vaXNlRm9saWFnZV0NCltNRVRBX2VtTm9pc2VOb3Jtc10NCjEsMiwiZjMxNSIsIjMxLDUiLCwsMywwLjAsIlxcZHsxLH0oW1xcUi5dezAsMX1cXGR7MCwxfSl7MCwxfSIsMSw0MCwwLDIwMCwixO7v8/Hy6Oz75SDz8O7i7egg5+Lz6u7i7uPuIOTg4uvl7ej/LCDkwSwg4iDu6vLg4u379SDv7uvu8eD1IPEg0cPXIOIgw/YiOw0KMiwyLCJmNjMiLDYzLCwsNCwwLjAsIlxcZHsxLH0oW1xcUi5dezAsMX1cXGR7MCwxfSl7MCwxfSIsMSw0MCwwLDIwMCwixO7v8/Hy6Oz75SDz8O7i7egg5+Lz6u7i7uPuIOTg4uvl7ej/LCDkwSwg4iDu6vLg4u379SDv7uvu8eD1IPEg0cPXIOIgw/YiOw0KMywyLCJmMTI1IiwxMjUsLCw1LDAuMCwiXFxkezEsfShbXFxSLl17MCwxfVxcZHswLDF9KXswLDF9IiwxLDQwLDAsMjAwLCLE7u/z8fLo7PvlIPPw7uLt6CDn4vPq7uLu4+4g5ODi6+Xt6P8sIOTBLCDiIO7q8uDi7fv1IO/u6+7x4PUg8SDRw9cg4iDD9iI7DQo0LDIsImYyNTAiLDI1MCwsLDYsMC4wLCJcXGR7MSx9KFtcXFIuXXswLDF9XFxkezAsMX0pezAsMX0iLDEsNDAsMCwyMDAsIsTu7/Px8ujs++Ug8/Du4u3oIOfi8+ru4u7j7iDk4OLr5e3o/ywg5MEsIOIg7ury4OLt+/Ug7+7r7vHg9SDxINHD1yDiIMP2IjsNCjUsMiwiZjUwMCIsNTAwLCwsNywwLjAsIlxcZHsxLH0oW1xcUi5dezAsMX1cXGR7MCwxfSl7MCwxfSIsMSw0MCwwLDIwMCwixO7v8/Hy6Oz75SDz8O7i7egg5+Lz6u7i7uPuIOTg4uvl7ej/LCDkwSwg4iDu6vLg4u379SDv7uvu8eD1IPEg0cPXIOIgw/YiOw0KNiwyLCJmMTAwMCIsMTAwMCwsLDgsMC4wLCJcXGR7MSx9KFtcXFIuXXswLDF9XFxkezAsMX0pezAsMX0iLDEsNDAsMCwyMDAsIsTu7/Px8ujs++Ug8/Du4u3oIOfi8+ru4u7j7iDk4OLr5e3o/ywg5MEsIOIg7ury4OLt+/Ug7+7r7vHg9SDxINHD1yDiIMP2IjsNCjcsMiwiZjIwMDAiLDIwMDAsLCw5LDAuMCwiXFxkezEsfShbXFxSLl17MCwxfVxcZHswLDF9KXswLDF9IiwxLDQwLDAsMjAwLCLE7u/z8fLo7PvlIPPw7uLt6CDn4vPq7uLu4+4g5ODi6+Xt6P8sIOTBLCDiIO7q8uDi7fv1IO/u6+7x4PUg8SDRw9cg4iDD9iI7DQo4LDIsImY0MDAwIiw0MDAwLCwsMTAsMC4wLCJcXGR7MSx9KFtcXFIuXXswLDF9XFxkezAsMX0pezAsMX0iLDEsNDAsMCwyMDAsIsTu7/Px8ujs++Ug8/Du4u3oIOfi8+ru4u7j7iDk4OLr5e3o/ywg5MEsIOIg7ury4OLt+/Ug7+7r7vHg9SDxINHD1yDiIMP2IjsNCjksMiwiZjgwMDAiLDgwMDAsLCwxMSwwLjAsIlxcZHsxLH0oW1xcUi5dezAsMX1cXGR7MCwxfSl7MCwxfSIsMSw0MCwwLDIwMCwixO7v8/Hy6Oz75SDz8O7i7egg5+Lz6u7i7uPuIOTg4uvl7ej/LCDkwSwg4iDu6vLg4u379SDv7uvu8eD1IPEg0cPXIOIgw/YiOw0KMTAsMiwiZkxhIiwiTGEiLCwsMTIsMC4wLCJcXGR7MSx9KFtcXFIuXXswLDF9XFxkezAsMX0pezAsMX0iLDEsNDAsMCwyMDAsIsTu7/Px8ujs++Ug8/Du4u3oIOfi8+rgLCDkwcAiOw0KMTEsMiwiZkxhTWF4IiwiTGEu7ODq8SIsLCwxMywwLjAsIlxcZHsxLH0oW1xcUi5dezAsMX1cXGR7MCwxfSl7MCwxfSIsMSw1MCwwLDIwMCwixO7v8/Hy6Oz75SDz8O7i7egg5+Lz6uAsIOTBwCI7DQpbZW1Ob2lzZU5vcm1zXQ0KW2VtM0RMaWJyYXJ5XQ==";

  function parseTpl() {
    const raw = Uint8Array.from(atob(TPL_B64.replace(/\s+/g, '')), c => c.charCodeAt(0));
    const txt = b2s(raw);
    const lines = txt.split(/\r?\n/);
    let iSrc = -1, iObs = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] === '[emNoiseSource]' && iSrc < 0) iSrc = i;
      if (lines[i] === '[META_emNoiseObstacle]' && iObs < 0) { iObs = i; break; }
    }
    if (iSrc < 0 || iObs < 0) throw new Error('Не найдены секции [emNoiseSource] или [META_emNoiseObstacle] в шаблоне');
    return { hdr: lines.slice(0, iSrc + 1).join('\r\n'), ftr: lines.slice(iObs).join('\r\n') };
  }

  let hdr = '', ftr = '', _tplError = null;
  function _ensureTpl() {
    if (hdr || _tplError) return;
    try { ({ hdr, ftr } = parseTpl()); }
    catch (e) { _tplError = e; console.error('noise-converter: шаблон', e); }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Состояние таблицы
  // ══════════════════════════════════════════════════════════════════════════
  const COLS = ['name', 'x', 'y', 'h', 'f315', 'f63', 'f125', 'f250', 'f500', 'f1k', 'f2k', 'f4k', 'f8k', 'la', 'lamax', 'omega', 'st'];
  const DEFS = { h: '2.6', omega: '12.5663706143592', st: '0' };
  let rows = [];
  let selIdx = -1;

  function addRow(d) { rows.push(d || {}); render(); }

  function render() {
    const tb = document.getElementById('nc-tbody');
    if (!tb) return;
    tb.innerHTML = '';
    rows.forEach((r, i) => {
      const tr = document.createElement('tr');
      if (i === selIdx) tr.classList.add('nc-sel');
      tr.onclick = () => {
        selIdx = i;
        document.querySelectorAll('#nc-tbody tr').forEach((row, j) => row.classList.toggle('nc-sel', j === i));
      };
      const td0 = document.createElement('td');
      td0.className = 'nc-num'; td0.textContent = i + 1; tr.appendChild(td0);
      COLS.forEach(k => {
        const td = document.createElement('td');
        const inp = document.createElement('input');
        inp.value = r[k] || '';
        inp.placeholder = DEFS[k] || '';
        inp.oninput = e => { rows[i][k] = e.target.value; };
        inp.onkeydown = e => handleKey(e, i, COLS.indexOf(k));
        inp.onpaste = e => {
          const txt = (e.clipboardData || window.clipboardData).getData('text/plain');
          if (!txt.includes('\t') && !txt.includes('\n')) return;
          e.preventDefault(); e.stopPropagation();
          const ci = COLS.indexOf(k);
          txt.split(/\r?\n/).filter(l => l.trim()).forEach((line, li) => {
            const ri2 = i + li;
            while (rows.length <= ri2) rows.push({});
            line.split('\t').forEach((v, vi) => { const col = ci + vi; if (col < COLS.length) rows[ri2][COLS[col]] = v.trim(); });
          });
          render();
        };
        td.appendChild(inp); tr.appendChild(td);
      });
      tb.appendChild(tr);
    });
    const st = document.getElementById('nc-st');
    if (st) st.textContent = 'Строк: ' + rows.length;
  }

  function handleKey(e, ri, ci) {
    if (e.key === 'Tab') return;
    if (e.key === 'Enter') {
      e.preventDefault();
      if (ri === rows.length - 1) addRow();
      else {
        const inputs = document.querySelectorAll('#nc-tbody tr')[ri + 1].querySelectorAll('input');
        if (inputs[ci]) inputs[ci].focus();
      }
    }
    if (e.key === 'ArrowDown' && ri < rows.length - 1) {
      const inputs = document.querySelectorAll('#nc-tbody tr')[ri + 1].querySelectorAll('input');
      if (inputs[ci]) { e.preventDefault(); inputs[ci].focus(); }
    }
    if (e.key === 'ArrowUp' && ri > 0) {
      const inputs = document.querySelectorAll('#nc-tbody tr')[ri - 1].querySelectorAll('input');
      if (inputs[ci]) { e.preventDefault(); inputs[ci].focus(); }
    }
  }

  function delSelected() {
    if (selIdx < 0 || selIdx >= rows.length) { setSt('Сначала выдели строку кликом', 'err'); return; }
    rows.splice(selIdx, 1);
    if (selIdx >= rows.length) selIdx = rows.length - 1;
    render();
  }
  function clearAllRows() {
    if (!rows.length) return;
    askConfirm('Очистить таблицу?', `Будет удалено строк: ${rows.length}. Отменить это нельзя.`, () => {
      rows = []; selIdx = -1; render();
    });
  }
  function moveUp() { if (selIdx > 0) { [rows[selIdx - 1], rows[selIdx]] = [rows[selIdx], rows[selIdx - 1]]; selIdx--; render(); } }
  function moveDown() { if (selIdx >= 0 && selIdx < rows.length - 1) { [rows[selIdx], rows[selIdx + 1]] = [rows[selIdx + 1], rows[selIdx]]; selIdx++; render(); } }

  // ══════════════════════════════════════════════════════════════════════════
  //  Импорт CSV (cp1251/UTF-8, разделитель ; или Tab)
  // ══════════════════════════════════════════════════════════════════════════
  function loadCSV(inp) {
    const f = inp.files[0]; if (!f) return;
    inp.value = '';
    const rd = new FileReader();
    rd.onload = e => {
      const raw = new Uint8Array(e.target.result);
      let txt;
      if (raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF) txt = new TextDecoder('utf-8').decode(raw);
      else { try { txt = new TextDecoder('windows-1251').decode(raw); } catch (err) { txt = new TextDecoder('utf-8').decode(raw); } }
      parseCSVText(txt);
    };
    rd.readAsArrayBuffer(f);
  }

  function parseCSVText(txt) {
    const lines = txt.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) { askNotice('CSV слишком короткий или пустой'); return; }
    const sep = lines[0].includes('\t') ? '\t' : ';';
    const c0 = lines[0].split(sep);
    const start = (c0.length > 1 && /^-?\d+([.,]\d+)?$/.test((c0[1] || '').trim())) ? 0 : 1;
    const added = [];
    for (let i = start; i < lines.length; i++) {
      const c = lines[i].split(sep).map(s => s.trim());
      if (!c[0] || c[0].length < 2) continue;
      added.push({
        name: c[0], x: c[1] || '', y: c[2] || '', h: c[3] || '',
        f315: c[4] || '', f63: c[5] || '', f125: c[6] || '', f250: c[7] || '',
        f500: c[8] || '', f1k: c[9] || '', f2k: c[10] || '', f4k: c[11] || '',
        f8k: c[12] || '', la: c[13] || '', lamax: c[14] || '', omega: c[15] || '',
        st: c[16] || '',
      });
    }
    if (!added.length) { askNotice('Не удалось распознать ни одной строки в CSV'); return; }
    const apply = () => { selIdx = -1; render(); setSt(`Загружено источников: ${added.length}`, 'ok'); };
    if (rows.length > 0) {
      // Явный выбор только «добавить» или «не загружать» — «заменить всё» не
      // прячем за кнопкой «Отмена» (слишком легко случайно стереть таблицу);
      // кто хочет заменить — сначала жмёт «🗑 Очистить» сам.
      askConfirm('Добавить к существующим?',
        `Добавить ${added.length} строк к уже введённым (${rows.length})? Чтобы заменить всё — сначала очисти таблицу.`,
        () => { rows = rows.concat(added); apply(); },
        { ok: 'Добавить', danger: false });
    } else {
      rows = added; apply();
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Вставка из Excel (Ctrl+V) — активна только пока открыт этот режим
  // ══════════════════════════════════════════════════════════════════════════
  function _onPaste(e) {
    const editor = document.getElementById('noise-editor');
    if (!editor || editor.style.display === 'none') return;
    const el = document.activeElement;
    if (el && el.tagName === 'INPUT') return; // обычная вставка в поле — не перехватываем
    const txt = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
    if (!txt) return;
    const lines = txt.split(/\r?\n/).filter(l => l.trim());
    if (!lines.length) return;
    lines.forEach(line => {
      const c = line.split('\t').map(s => s.trim());
      if (!c[0]) return;
      rows.push({
        name: c[0], x: c[1] || '', y: c[2] || '', h: c[3] || '',
        f315: c[4] || '', f63: c[5] || '', f125: c[6] || '', f250: c[7] || '',
        f500: c[8] || '', f1k: c[9] || '', f2k: c[10] || '', f4k: c[11] || '',
        f8k: c[12] || '', la: c[13] || '', lamax: c[14] || '', omega: c[15] || '',
        st: c[16] || '',
      });
    });
    render();
  }
  document.addEventListener('paste', _onPaste);

  // ══════════════════════════════════════════════════════════════════════════
  //  Генерация .int — скачивание через _download() (a.click() под pywebview
  //  заблокирован, см. шапку файла)
  // ══════════════════════════════════════════════════════════════════════════
  function numv(v, def) { const s = (v || '').replace(',', '.').replace(/[^0-9.\-]/g, ''); return s || def; }

  async function generate() {
    _ensureTpl();
    if (!hdr) { askNotice('Шаблон не загружен: ' + (_tplError ? _tplError.message : 'неизвестная ошибка')); return; }
    const valid = rows.filter(r => r.name && r.name.trim().length >= 2);
    if (!valid.length) { askNotice('Нет данных для экспорта. Добавь хотя бы одну строку с названием.'); return; }

    let src = '';
    valid.forEach((r, i) => {
      const id = i + 1;
      const dn = String(i + 1).padStart(4, '0');
      const ns = (r.name || '').replace(/"/g, '""');
      const x = numv(r.x, '0'), y = numv(r.y, '0'), h = numv(r.h, '2.6');
      const f315 = numv(r.f315, '0'), f63 = numv(r.f63, '0'), f125 = numv(r.f125, '0');
      const f250 = numv(r.f250, '0'), f500 = numv(r.f500, '0'), f1k = numv(r.f1k, '0');
      const f2k = numv(r.f2k, '0'), f4k = numv(r.f4k, '0'), f8k = numv(r.f8k, '0');
      const la = numv(r.la, '0');
      const omega = numv(r.omega, '12.5663706143592');
      // Формат как в собственном экспорте Эколог-Шум: основная строка + подстроки
      // :0 и :10001 (в них октавные уровни — дублируются под два спектра)
      const spec = `${f315},${f63},${f125},${f250},${f500},${f1k},${f2k},${f4k},${f8k},${la}`;
      src += `${id},"${ns}",${dn},${h},0,1,1,0,${x},${y},0,\r\n`;
      src += `:0,,${spec},${omega},,"True",0,,,0,5,\r\n`;
      src += `:10001,,${spec},0,,,0,5,${omega},;\r\n`;
    });

    const full = hdr + '\r\n' + src + ftr;
    const bytes = s2b(full);
    const blob = new Blob([bytes], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    try {
      await (typeof _download === 'function' ? _download(url, 'импорт_источники.int') : Promise.resolve().then(() => {
        const a = document.createElement('a'); a.href = url; a.download = 'импорт_источники.int'; a.click();
      }));
      setSt(`Файл импорт_источники.int готов (${valid.length} источников). Загрузите его в Эколог-Шум: «Загрузить акустические данные».`, 'ok');
    } catch (e) {
      askNotice('Ошибка сохранения файла: ' + e.message);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Разметка (строится один раз при первом входе в режим)
  // ══════════════════════════════════════════════════════════════════════════
  const COL_DEFS = [
    ['Название источника', 200], ['X', 85], ['Y', 85], ['Высота', 55],
    ['f31.5', 45], ['f63', 40], ['f125', 45], ['f250', 45], ['f500', 45],
    ['f1000', 52], ['f2000', 52], ['f4000', 52], ['f8000', 52],
    ['La', 40], ['La.макс', 55], ['Ω (рад/с)', 90], ['Тип', 45],
  ];

  function _noisePaneHtml() {
    const ths = COL_DEFS.map(([name, w]) => `<th style="min-width:${w}px">${name}</th>`).join('');
    return `
<div class="nc-toolbar">
  <label class="nc-btn nc-btn-file" title="Загрузить CSV (cp1251 или UTF-8, разделитель ; или Tab)">
    📂 Загрузить CSV <input type="file" id="nc-csv-file" accept=".csv,.txt" style="display:none" onchange="NoiseConv.loadCSV(this)">
  </label>
  <button class="nc-btn" onclick="NoiseConv.addRow()">＋ Строка</button>
  <button class="nc-btn nc-btn-red" onclick="NoiseConv.delSelected()">✕ Удалить</button>
  <button class="nc-btn nc-btn-orange" onclick="NoiseConv.clearAllRows()">🗑 Очистить</button>
  <div class="nc-sep"></div>
  <button class="nc-btn" onclick="NoiseConv.moveUp()">↑</button>
  <button class="nc-btn" onclick="NoiseConv.moveDown()">↓</button>
  <div style="flex:1"></div>
  <button class="nc-btn nc-btn-green" onclick="NoiseConv.generate()">▶ Создать импорт_источники.int</button>
</div>
<div class="nc-wrap">
<table class="nc-table">
<thead><tr><th class="nc-num" style="min-width:32px">#</th>${ths}</tr></thead>
<tbody id="nc-tbody"></tbody>
</table>
</div>
<div class="nc-statusbar">
  <span id="nc-st">Строк: 0</span>
  <span class="nc-hint">Совет: вставьте данные из Excel (Ctrl+V) или загрузите CSV</span>
</div>`;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Оболочка режима: общая шапка + переключатель вкладок конвертеров.
  //  Сам #noise-editor остался прежним именем (элемент/функции не переименовывал
  //  — он не виден пользователю), но теперь хозяин двух вкладок, не одной.
  // ══════════════════════════════════════════════════════════════════════════
  function _shellHtml() {
    return `
<header>
  <button class="pdf-back-btn" onclick="exitNoiseMode()" style="margin-right:14px">← Карта</button>
  <div style="flex:1">
    <div class="sub">Интеграл</div>
    <h1>Конвертер</h1>
  </div>
  <div class="nc-tabs">
    <button class="nc-tabbtn nc-tabbtn-active" id="nc-tab-noise" onclick="ConvHub.switchTab('noise')">Шум → INT</button>
    <button class="nc-tabbtn" id="nc-tab-ecolog" onclick="ConvHub.switchTab('ecolog')">УПРЗА Эколог → XML</button>
  </div>
</header>
<div id="nc-pane-noise" class="nc-pane"></div>
<div id="nc-pane-ecolog" class="nc-pane" style="display:none"></div>`;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Вход / выход из режима (по образцу enterRiskMode()/enterPdfMode())
  // ══════════════════════════════════════════════════════════════════════════
  let _inited = false;

  window.enterNoiseMode = function () {
    const editor = document.getElementById('noise-editor');
    if (!editor) return;
    // 'flex', не 'block' — #noise-editor раскладка flex-колонкой (шапка/
    // вкладки/панель), 'block' в инлайн-style перебивал бы display:flex
    // из CSS (инлайн-стиль всегда сильнее), и содержимое растягивалось бы
    // под контент вместо прокрутки внутри себя
    editor.style.display = 'flex';
    if (!_inited) {
      _inited = true;
      editor.innerHTML = _shellHtml();
      document.getElementById('nc-pane-noise').innerHTML = _noisePaneHtml();
      _ensureTpl();
      if (_tplError) setSt('Ошибка шаблона INT: ' + _tplError.message, 'err');
      addRow(); // первая пустая строка
    }
  };
  window.exitNoiseMode = function () {
    const editor = document.getElementById('noise-editor');
    if (editor) editor.style.display = 'none';
  };

  // ══════════════════════════════════════════════════════════════════════════
  //  Переключатель вкладок конвертеров (общий для noise-converter.js и
  //  econ-converter.js — второй строит свою панель лениво, при первом
  //  переключении на неё, тем же приёмом, что и сам режим при входе).
  // ══════════════════════════════════════════════════════════════════════════
  window.ConvHub = {
    switchTab(name) {
      const panes = { noise: 'nc-pane-noise', ecolog: 'nc-pane-ecolog' };
      Object.entries(panes).forEach(([key, id]) => {
        const pane = document.getElementById(id);
        if (pane) pane.style.display = key === name ? 'flex' : 'none';
        const tab = document.getElementById('nc-tab-' + key);
        if (tab) tab.classList.toggle('nc-tabbtn-active', key === name);
      });
      if (name === 'ecolog' && typeof window.EconConv !== 'undefined') window.EconConv.ensureInit();
    },
  };

  // ══════════════════════════════════════════════════════════════════════════
  //  Публичный интерфейс — разметка дёргает обработчики через NoiseConv.*
  // ══════════════════════════════════════════════════════════════════════════
  window.NoiseConv = { addRow, delSelected, clearAllRows, moveUp, moveDown, loadCSV, generate };
})();
