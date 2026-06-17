const monthTitleEl = document.querySelector('#monthTitle');
const calendarGridEl = document.querySelector('#calendarGrid');
const selectedDateTitleEl = document.querySelector('#selectedDateTitle');
const dayMetaEl = document.querySelector('#dayMeta');
const dayPapersEl = document.querySelector('#dayPapers');
const markedPapersEl = document.querySelector('#markedPapers');
const template = document.querySelector('#smallPaperTemplate');

const state = {
  viewDate: new Date(),
  digestDates: new Set(),
  markSummary: {}
};

async function getJson(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

function dateKeyFromParts(y, m, d) {
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function clearList(el, message) {
  el.innerHTML = '';
  if (message) {
    const p = document.createElement('p');
    p.className = 'meta';
    p.textContent = message;
    el.appendChild(p);
  }
}

function createPaperCard(paper) {
  const node = template.content.cloneNode(true);
  node.querySelector('h4').textContent = paper.title;
  node.querySelector('.authors').textContent = `作者：${paper.authors.join(', ') || '未知'}`;
  node.querySelector('.summary').textContent = paper.summary;

  const abs = node.querySelector('.abs');
  abs.href = paper.url;

  const pdf = node.querySelector('.pdf');
  if (paper.pdfUrl) {
    pdf.href = paper.pdfUrl;
  } else {
    pdf.remove();
  }
  return node;
}

async function loadDateDetail(dateKey) {
  selectedDateTitleEl.textContent = `${dateKey} 论文清单`;

  let digest;
  try {
    digest = await getJson(`/api/digest/${dateKey}`);
  } catch {
    try {
      const fetched = await getJson(`/api/digest/fetch/${dateKey}`, { method: 'POST' });
      digest = fetched.digest;
      state.digestDates.add(dateKey);
      renderCalendar();
    } catch {
      dayMetaEl.textContent = '该日期拉取失败或暂无论文。';
      clearList(dayPapersEl, '无论文');
      clearList(markedPapersEl, '无 Mark');
      return;
    }
  }

  const markRes = await getJson(`/api/marks/${dateKey}`);
  const markSet = new Set(markRes.paperIds || []);

  dayMetaEl.textContent = `推荐数：${digest.papers.length}，Mark 数：${markSet.size}`;

  clearList(dayPapersEl);
  for (const paper of digest.papers) {
    dayPapersEl.appendChild(createPaperCard(paper));
  }

  const markedPapers = digest.papers.filter((paper) => markSet.has(paper.id));
  clearList(markedPapersEl, markedPapers.length ? '' : '当日暂无 Mark 论文');
  for (const paper of markedPapers) {
    markedPapersEl.appendChild(createPaperCard(paper));
  }
}

function renderCalendar() {
  const year = state.viewDate.getFullYear();
  const month = state.viewDate.getMonth();
  const first = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const leading = (first.getDay() + 6) % 7;

  monthTitleEl.textContent = `${year}年 ${month + 1}月`;
  calendarGridEl.innerHTML = '';

  ['一', '二', '三', '四', '五', '六', '日'].forEach((w) => {
    const label = document.createElement('div');
    label.className = 'weekday';
    label.textContent = w;
    calendarGridEl.appendChild(label);
  });

  for (let i = 0; i < leading; i += 1) {
    const empty = document.createElement('div');
    empty.className = 'day-cell empty';
    calendarGridEl.appendChild(empty);
  }

  for (let day = 1; day <= daysInMonth; day += 1) {
    const key = dateKeyFromParts(year, month, day);
    const hasDigest = state.digestDates.has(key);
    const markCount = state.markSummary[key] || 0;

    const btn = document.createElement('button');
    btn.className = `day-cell${hasDigest ? ' has-digest' : ''}`;
    btn.type = 'button';
    btn.innerHTML = `<span>${day}</span><small>${markCount ? `Mark ${markCount}` : hasDigest ? '有推荐' : ''}</small>`;
    btn.addEventListener('click', () => {
      loadDateDetail(key).catch((error) => {
        dayMetaEl.textContent = error.message;
      });
    });
    calendarGridEl.appendChild(btn);
  }
}

async function loadCalendarData() {
  const [dates, markSummary] = await Promise.all([
    getJson('/api/digest/dates'),
    getJson('/api/marks/summary')
  ]);
  state.digestDates = new Set(dates);
  state.markSummary = markSummary;
}

document.querySelector('#prevMonth').addEventListener('click', () => {
  state.viewDate = new Date(state.viewDate.getFullYear(), state.viewDate.getMonth() - 1, 1);
  renderCalendar();
});

document.querySelector('#nextMonth').addEventListener('click', () => {
  state.viewDate = new Date(state.viewDate.getFullYear(), state.viewDate.getMonth() + 1, 1);
  renderCalendar();
});

async function boot() {
  await loadCalendarData();
  renderCalendar();
}

boot().catch((error) => {
  dayMetaEl.textContent = `初始化失败：${error.message}`;
});
