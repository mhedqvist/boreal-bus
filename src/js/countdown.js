import { getLiveVehiclesSchedule } from './poller.js';

// Shows the time left until the next bus position refresh in the header.
export function initCountdown(elementId = 'refresh-countdown') {
  const el = document.getElementById(elementId);
  if (!el) return;

  function update() {
    const { nextAt, running } = getLiveVehiclesSchedule();
    if (running) {
      el.textContent = '(updating…)';
    } else if (nextAt) {
      el.textContent = `(update in: ${Math.max(0, Math.ceil((nextAt - Date.now()) / 1000))} s)`;
    } else {
      el.textContent = '';
    }
  }

  update();
  setInterval(update, 1000);
}
