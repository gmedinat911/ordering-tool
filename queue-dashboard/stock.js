// dashboard-frontend/stock.js
const BACKEND_URL = 'https://whatsapp-cocktail-bot.onrender.com';
const token = localStorage.getItem('jwt');
if (!token) {
  window.location.href = '/';
}
axios.defaults.headers.common['Authorization'] = `Bearer ${token}`;

function logout() {
  localStorage.removeItem('jwt');
  window.location.href = '/';
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
        <td class="px-4 py-2 text-center space-x-2">
          <input 
            type="number" 
            min="0" 
            value="${drink.stock_count}" 
            data-id="${drink.id}" 
            class="stock-input border rounded px-1 py-1 w-20 text-center"
          />
          <button 
            data-id="${drink.id}" 
            class="set-btn bg-blue-500 hover:bg-blue-600 text-white px-2 py-1 rounded text-sm"
          >
            Set
          </button>
          <button 
            data-id="${drink.id}" 
            data-delta="1" 
            class="delta-btn bg-green-500 hover:bg-green-600 text-white px-2 py-1 rounded text-sm"
          >
            +1
          </button>
          <button 
            data-id="${drink.id}" 
            data-delta="-1" 
            class="delta-btn bg-yellow-500 hover:bg-yellow-600 text-white px-2 py-1 rounded text-sm"
            ${drink.stock_count === 0 ? 'disabled' : ''}
          >
            -1
          </button>
        </td>
      `;
      tbody.appendChild(tr);
    });

    // Delta buttons
    document.querySelectorAll('.delta-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = +btn.getAttribute('data-id');
        const delta = +btn.getAttribute('data-delta');
        try {
          await axios.post(`${BACKEND_URL}/stock`, { id, delta });
          fetchStock();
        } catch (err) {
          console.error('Stock update failed', err);
          if (err.response?.status === 401) logout();
        }
      });
    });

    // Set buttons
    document.querySelectorAll('.set-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = +btn.getAttribute('data-id');
        const input = document.querySelector(`.stock-input[data-id="${id}"]`);
        const absolute = +input.value;
        try {
          await axios.post(`${BACKEND_URL}/stock`, { id, absolute });
          fetchStock();
        } catch (err) {
          console.error('Stock set failed', err);
          if (err.response?.status === 401) logout();
        }
      });
    });
  } catch (err) {
    console.error('Failed to fetch stock', err);
    if (err.response?.status === 401) logout();
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