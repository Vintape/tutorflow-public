(() => {
  'use strict'

  const icons = {
    brand: '<path d="M4 6.5c3.5-1.8 5.6-1.6 8 .8 2.4-2.4 4.5-2.6 8-.8v11c-3.5-1.6-5.6-1.4-8 1-2.4-2.4-4.5-2.6-8-1zM12 7.5v11"/>',
    calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 9.5h17M8 3.5v3M16 3.5v3M8 13h2m4 0h2m-8 4h2"/>',
    board: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M12 17v4m-3 0h6m-8-7 3-4 3 2 4-5"/>',
    report: '<path d="M6 3.5h8l4 4v13H6zM14 3.5v4h4M9 12h6m-6 4h6"/>',
    wallet: '<path d="M20 8V6a2 2 0 0 0-2-2H6a3 3 0 0 0 0 6h14v10H6a3 3 0 0 1-3-3V7M20 13h-5a2 2 0 0 0 0 4h5m-5-2h.2"/>',
    left: '<path d="m14 6-6 6 6 6"/>',
    right: '<path d="m10 6 6 6-6 6"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    pen: '<path d="m4 20 4.5-1 11-11a2.1 2.1 0 0 0-3-3l-11 11L4 20zM14.5 7.5l3 3"/>',
    reset: '<path d="M5 11a7 7 0 1 1 2 6M5 5v6h6"/>',
  }

  const lessons = [
    { id: 'l1', date: '2026-11-16', time: '15:30', name: 'Лиза Мельник', topic: 'Математика · дроби', charge: 1600, paid: 1600 },
    { id: 'l2', date: '2026-11-17', time: '17:00', name: 'Саша Невский', topic: 'Физика · законы Ньютона', charge: 1800, paid: 1800 },
    { id: 'l3', date: '2026-11-18', time: '14:00', name: 'Миша Орлов', topic: 'Алгебра · квадратичная функция', charge: 1800, paid: 0, board: true },
    { id: 'l4', date: '2026-11-18', time: '16:30', name: 'Лиза Мельник', topic: 'Математика · проценты', charge: 1600, paid: 1000 },
    { id: 'l5', date: '2026-11-18', time: '18:00', name: 'Саша Невский', topic: 'Физика · работа и мощность' },
    { id: 'l6', date: '2026-11-20', time: '16:00', name: 'Миша Орлов', topic: 'Алгебра · вершина параболы', board: true },
    { id: 'l7', date: '2026-11-24', time: '17:00', name: 'Саша Невский', topic: 'Физика · энергия' },
  ]

  const reports = [
    { lesson: 'l3', status: 'Черновик', covered: 'Разобрали, как знак коэффициента a определяет направление ветвей параболы. Построили график y = x² − 1 и нашли его нули.', progress: 'Миша самостоятельно нашёл точки пересечения с осью x и объяснил, как смещается вершина.', next: 'Построить графики y = x² + 2 и y = −x² + 1, отметить их вершины.' },
    { lesson: 'l4', status: 'Проверен', covered: 'Повторили перевод процентов в дроби и разобрали задачи на скидки.', progress: 'Лиза уверенно находит процент от числа. Задачи с последовательными изменениями пока требуют подсказок.', next: 'Решить две задачи на последовательное повышение и снижение цены.' },
  ]

  const viewElement = document.querySelector('#view')
  const dialog = document.querySelector('#lesson-dialog')
  const dateOptions = { timeZone: 'UTC' }
  const dayLabel = new Intl.DateTimeFormat('ru-RU', { weekday: 'short', ...dateOptions })
  const longDate = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', weekday: 'long', ...dateOptions })
  const shortDate = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', ...dateOptions })
  const money = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 })
  const firstWeek = Date.UTC(2026, 10, 16)
  const dayInMilliseconds = 24 * 60 * 60 * 1000
  let firstDay = firstWeek
  let selectedDay = 2
  let selectedReport = 0
  let activeView = 'schedule'
  let boardObserver

  function markIcons(root) {
    for (const element of root.querySelectorAll('[data-icon]')) {
      element.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[element.dataset.icon]}</svg>`
    }
  }

  function daysFrom(start) {
    return Array.from({ length: 7 }, (_, index) => new Date(start + index * dayInMilliseconds))
  }

  function isoDate(date) {
    return date.toISOString().slice(0, 10)
  }

  function heading(title, controls = '') {
    return `<div class="view-heading"><h2 id="section-title">${title}</h2>${controls}</div>`
  }

  function arrow(direction, label) {
    return `<button type="button" class="control icon-control" data-step="${direction}" aria-label="${label}"><span data-icon="${direction < 0 ? 'left' : 'right'}"></span></button>`
  }

  function lessonBadge(lesson) {
    return lesson.charge ? '<span class="badge">Проведено</span>' : '<span class="badge planned">Запланировано</span>'
  }

  function renderSchedule() {
    const dates = daysFrom(firstDay)
    const datesThisWeek = dates.map(isoDate)
    const weekLessons = lessons.filter((lesson) => datesThisWeek.includes(lesson.date))
    const dayLessons = weekLessons.filter((lesson) => lesson.date === datesThisWeek[selectedDay])
    const completed = weekLessons.filter((lesson) => lesson.charge).length
    const received = weekLessons.reduce((sum, lesson) => sum + (lesson.paid ?? 0), 0)
    const weekControls = `
      <div class="week-controls">
        ${arrow(-1, 'Предыдущая неделя')}
        <span class="week-label" aria-live="polite">${shortDate.formatRange(dates[0], dates[6])} ${dates[6].getUTCFullYear()}</span>
        ${arrow(1, 'Следующая неделя')}
      </div>`
    viewElement.innerHTML = `
      ${heading('Расписание', weekControls)}
      <div class="schedule-grid">
        <section class="panel" aria-labelledby="agenda-title">
          <div class="week" role="group" aria-label="Дни недели">
            ${dates.map((date, index) => `
              <button type="button" class="day ${weekLessons.some((lesson) => lesson.date === isoDate(date)) ? 'has-lessons' : ''}" data-day="${index}" aria-label="${longDate.format(date)}" aria-pressed="${index === selectedDay}">
                <span>${dayLabel.format(date)}</span><strong>${date.getUTCDate()}</strong>
              </button>`).join('')}
          </div>
          <div class="agenda">
            <h3 id="agenda-title">${longDate.format(dates[selectedDay])}</h3>
            <div class="lesson-list">
              ${dayLessons.map((lesson) => `
                <button type="button" class="lesson" data-lesson="${lesson.id}">
                  <span class="lesson-time">${lesson.time}</span>
                  <span><span class="lesson-name">${lesson.name}</span><span class="lesson-topic">${lesson.topic}</span></span>
                  ${lessonBadge(lesson)}
                </button>`).join('') || '<p class="empty">На этот день занятий нет.</p>'}
            </div>
          </div>
        </section>
        <section class="panel summary-card" aria-labelledby="summary-title">
          <h3 id="summary-title">Итоги недели</h3>
          <dl class="metric-list">
            <div><dt>Проведено</dt><dd>${completed}</dd></div>
            <div><dt>Запланировано</dt><dd>${weekLessons.length - completed}</dd></div>
            <div><dt>Получено оплат</dt><dd>${money.format(received)}</dd></div>
          </dl>
        </section>
      </div>`
  }

  function openLesson(id) {
    const lesson = lessons.find((entry) => entry.id === id)
    const reportIndex = reports.findIndex((report) => report.lesson === id)
    dialog.innerHTML = `
      <div class="dialog-head"><h2 id="lesson-title">${lesson.name}</h2>
        <form method="dialog"><button type="submit" class="control icon-control" aria-label="Закрыть"><span data-icon="close"></span></button></form>
      </div>
      <p class="dialog-topic">${lesson.topic}<br>${longDate.format(new Date(lesson.date))}, ${lesson.time}</p>
      ${lessonBadge(lesson)}
      <div class="dialog-actions">
        ${lesson.board ? '<a class="action" href="#board">Открыть доску</a>' : ''}
        ${reportIndex >= 0 ? `<a class="action" href="#reports" data-open-report="${reportIndex}">Открыть отчёт</a>` : ''}
      </div>`
    markIcons(dialog)
    dialog.showModal()
  }

  function renderReports() {
    const report = reports[selectedReport]
    const lesson = lessons.find((entry) => entry.id === report.lesson)
    viewElement.innerHTML = `
      ${heading('Отчёты для родителей')}
      <div class="report-layout">
        <div class="panel report-list" role="group" aria-label="Примеры отчётов">
          ${reports.map((entry, index) => `
            <button type="button" class="report-choice" data-report="${index}" aria-pressed="${index === selectedReport}">
              <strong>${lessons.find((item) => item.id === entry.lesson).name}</strong><span class="badge ${index === 0 ? 'draft' : ''}">${entry.status}</span>
            </button>`).join('')}
        </div>
        <article class="panel report-detail" aria-label="Текст отчёта">
          <h3>${lesson.topic}</h3><p>${lesson.name} · ${shortDate.format(new Date(lesson.date))}</p>
          <h4>Что разобрали</h4><p>${report.covered}</p>
          <h4>Как продвигается ученик</h4><p>${report.progress}</p>
          <h4>К следующему занятию</h4><p>${report.next}</p>
        </article>
      </div>`
  }

  function renderFinances() {
    const charge = lessons.reduce((sum, lesson) => sum + (lesson.charge ?? 0), 0)
    const received = lessons.reduce((sum, lesson) => sum + (lesson.paid ?? 0), 0)
    viewElement.innerHTML = `
      ${heading('Финансы', '<span class="week-label">Ноябрь 2026</span>')}
      <div class="finance-grid">
        <section class="panel finance-card"><p>Начислено</p><strong>${money.format(charge)}</strong></section>
        <section class="panel finance-card"><p>Получено</p><strong>${money.format(received)}</strong></section>
        <section class="panel finance-card"><p>К оплате</p><strong>${money.format(charge - received)}</strong></section>
      </div>
      <section class="panel finance-history" aria-labelledby="payments-title">
        <h3 id="payments-title">Полученные оплаты</h3>
        <table>
          <thead><tr><th scope="col">Дата</th><th scope="col">Ученик</th><th scope="col">Сумма</th></tr></thead>
          <tbody>
            ${lessons.filter((lesson) => lesson.paid).toReversed().map((lesson) => `
              <tr><td>${shortDate.format(new Date(lesson.date))}</td><td>${lesson.name}</td><td>${money.format(lesson.paid)}</td></tr>`).join('')}
          </tbody>
        </table>
      </section>`
  }

  function renderBoard() {
    viewElement.innerHTML = `
      ${heading('Доска')}
      <section class="panel board-panel" aria-label="Демо-доска по алгебре">
        <div class="board-toolbar">
          <h3>График квадратичной функции</h3>
          <div class="tool-group">
            <button type="button" class="control" data-pen aria-pressed="true"><span data-icon="pen"></span>Карандаш</button>
            <button type="button" class="control" data-reset><span data-icon="reset"></span>Сбросить рисунок</button>
          </div>
        </div>
        <div class="board-surface"><canvas data-tool="pen" aria-label="График функции y = x² − 1 с вершиной в точке (0, −1). Рисуйте поверх примера мышью, пером или пальцем."></canvas></div>
        <p class="board-note">Демо-доска. Нарисуйте что-нибудь поверх графика или сбросьте рисунок.</p>
      </section>`
    const canvas = viewElement.querySelector('canvas')
    const penButton = viewElement.querySelector('[data-pen]')
    const context = canvas.getContext('2d')
    const strokes = []
    let activeStroke
    let activePointer

    function draw() {
      const { width, height } = canvas.getBoundingClientRect()
      const ratio = window.devicePixelRatio || 1
      canvas.width = Math.round(width * ratio)
      canvas.height = Math.round(height * ratio)
      context.setTransform(ratio, 0, 0, ratio, 0, 0)

      context.fillStyle = '#d7e6d8'
      for (let y = 9; y < height; y += 16) {
        for (let x = 9; x < width; x += 16) {
          context.fillRect(x, y, 1.3, 1.3)
        }
      }

      const centerX = width * 0.5
      const centerY = height * 0.57
      const grid = Math.min(width / 7.4, height / 6)
      context.strokeStyle = '#91aa9d'
      context.lineWidth = 1
      context.beginPath()
      context.moveTo(grid * .4, centerY)
      context.lineTo(width - grid * .4, centerY)
      context.moveTo(centerX, height - grid * .4)
      context.lineTo(centerX, grid * .4)
      context.stroke()

      context.strokeStyle = '#176c55'
      context.lineWidth = 2.6
      context.beginPath()
      for (let index = 0; index <= 100; index++) {
        const x = -2.02 + index * 4.04 / 100
        const pointX = centerX + x * grid
        const pointY = centerY - (x * x - 1) * grid
        if (index === 0) context.moveTo(pointX, pointY)
        else context.lineTo(pointX, pointY)
      }
      context.stroke()
      context.fillStyle = '#176c55'
      for (const [x, y] of [[-1, 0], [0, -1], [1, 0]]) {
        context.beginPath()
        context.arc(centerX + x * grid, centerY - y * grid, 4, 0, Math.PI * 2)
        context.fill()
      }

      context.fillStyle = '#49695a'
      context.font = '600 13px system-ui'
      context.fillText('y', centerX + 8, grid * .54)
      context.fillText('x', width - grid * .48, centerY - 8)
      context.fillText('0', centerX + 8, centerY + 16)
      context.fillText('−1', centerX - grid - 8, centerY + 18)
      context.fillText('1', centerX + grid - 3, centerY + 18)
      context.fillStyle = '#1a5b44'
      context.font = '650 17px system-ui'
      context.fillText('y = x² − 1', 16, 30)

      context.strokeStyle = '#876128'
      context.fillStyle = '#876128'
      context.lineWidth = 2.9
      context.lineCap = 'round'
      context.lineJoin = 'round'
      for (const stroke of strokes) {
        const [start] = stroke
        context.beginPath()
        context.moveTo(start.x * width, start.y * height)
        for (const point of stroke) context.lineTo(point.x * width, point.y * height)
        context.stroke()
        if (stroke.length === 1) {
          context.beginPath()
          context.arc(start.x * width, start.y * height, 1.5, 0, Math.PI * 2)
          context.fill()
        }
      }
    }

    function getPoint(event) {
      const bounds = canvas.getBoundingClientRect()
      return { x: (event.clientX - bounds.left) / bounds.width, y: (event.clientY - bounds.top) / bounds.height }
    }

    canvas.addEventListener('pointerdown', (event) => {
      if (canvas.dataset.tool !== 'pen' || event.button !== 0 || activeStroke) return
      activePointer = event.pointerId
      canvas.setPointerCapture(activePointer)
      activeStroke = [getPoint(event)]
      strokes.push(activeStroke)
      draw()
    })
    canvas.addEventListener('pointermove', (event) => {
      if (!activeStroke || event.pointerId !== activePointer) return
      activeStroke.push(getPoint(event))
      draw()
    })
    function endStroke(event) {
      if (event.pointerId === activePointer) activeStroke = undefined
    }
    canvas.addEventListener('pointerup', endStroke)
    canvas.addEventListener('pointercancel', endStroke)
    canvas.addEventListener('lostpointercapture', endStroke)
    penButton.addEventListener('click', () => {
      const enabled = penButton.getAttribute('aria-pressed') !== 'true'
      penButton.setAttribute('aria-pressed', enabled)
      canvas.dataset.tool = enabled ? 'pen' : ''
    })
    viewElement.querySelector('[data-reset]').addEventListener('click', () => {
      activeStroke = undefined
      strokes.length = 0
      draw()
    })

    boardObserver = new ResizeObserver(draw)
    boardObserver.observe(canvas)
    draw()
  }

  const views = { schedule: renderSchedule, board: renderBoard, reports: renderReports, finances: renderFinances }

  function render() {
    boardObserver?.disconnect()
    const requestedView = location.hash.slice(1)
    activeView = Object.hasOwn(views, requestedView) ? requestedView : 'schedule'
    for (const link of document.querySelectorAll('[data-view]')) {
      if (link.dataset.view === activeView) link.setAttribute('aria-current', 'page')
      else link.removeAttribute('aria-current')
    }
    views[activeView]()
    markIcons(viewElement)
  }

  viewElement.addEventListener('click', (event) => {
    const button = event.target.closest('button')
    if (!button) return
    if (button.hasAttribute('data-lesson')) {
      openLesson(button.dataset.lesson)
      return
    }
    const { step, day, report } = button.dataset
    if (step !== undefined) firstDay += Number(step) * 7 * dayInMilliseconds
    else if (day !== undefined) selectedDay = Number(day)
    else if (report !== undefined) selectedReport = Number(report)
    else return
    render()
    const key = Object.keys(button.dataset)[0]
    viewElement.querySelector(`[data-${key}="${button.dataset[key]}"]`)?.focus({ preventScroll: true })
  })
  dialog.addEventListener('click', (event) => {
    const link = event.target.closest('a')
    if (!link) return
    if (link.hasAttribute('data-open-report')) selectedReport = Number(link.dataset.openReport)
    dialog.close()
  })
  window.addEventListener('hashchange', render)

  markIcons(document)
  render()
})()
