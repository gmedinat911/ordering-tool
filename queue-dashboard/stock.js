// dashboard-frontend/stock.js
const BACKEND_URL = 'https://whatsapp-cocktail-bot.onrender.com';
const token = localStorage.getItem('jwt');
if (!token) {
  window.location.href = '/';
}
axios.defaults.headers.common['Authorization'] = `Bearer ${token}`;

function logout() {
  localStorage.removeItem('jwt');
  document.getElementById('logoutBtn').textContent = 'Logging out...';
  setTimeout(() => (window.location.href = '/'), 500);
}

async function fetchStock() {
  try {
    const res = await axios.get(`${BACKEND_URL}/menu`);
    const tbody = document.querySelector('#stockTable tbody');
    tbody.innerHTML = '';
    res.data.forEach(drink => {
      const tr = document.createElement('tr');
      tr.className = 'border-b';
      tr.innerHTML = `
        <td class="px-4 py-2">${drink.display_name}</td>
        <td class="px-4 py-2 text-center">${drink.stock_count}</td>
        <td class="px-4 py-2 text-center">
          <button data-id="${drink.id}" data-delta="1" class="delta-btn bg-green-500 hover:bg-green-600 text-white px-2 py-1 rounded text-sm mr-2">+1</button>
          <button data-id="${drink.id}" data-delta="-1" class="delta-btn bg-yellow-500 hover:bg-yellow-600 text-white px-2 py-1 rounded text-sm" ${drink.stock_count===0?'disabled':''}>-1</button>
        </td>
      `;
      tbody.appendChild(tr);
    });

    document.querySelectorAll('.delta-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = parseInt(btn.getAttribute('data-id'));
        const delta = parseInt(btn.getAttribute('data-delta'));
        try {
          await axios.post(`${BACKEND_URL}/stock`, { id, delta });
          fetchStock();
        } catch (err) {
          console.error('Stock update failed', err);
          if (err.response && err.response.status === 401) logout();
        }
      });
    });
  } catch (err) {
    console.error('Failed to fetch stock', err);
    if (err.response && err.response.status === 401) logout();
  }
}

document.getElementById('logoutBtn').addEventListener('click', logout);
document.getElementById('backBtn').addEventListener('click', () => {
  window.location.href = 'dashboard.html';
});

window.onload = () => {
  fetchStock();
  setInterval(fetchStock, 5000);
};
