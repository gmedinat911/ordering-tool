const token = localStorage.getItem('jwt');
if (!token) {
  window.location.href = '/';
}

axios.defaults.headers.common['Authorization'] = `Bearer ${token}`;
const BACKEND_URL = 'https://whatsapp-cocktail-bot.onrender.com';
const knownIds = new Set();

function relativeTime(ts) {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return 'Just now';
  if (sec < 3600) return `${Math.floor(sec / 60)} min ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} hr ago`;
  return `${Math.floor(sec / 86400)} d ago`;
}

function updateTimestamp() {
  const now = new Date().toLocaleTimeString();
  document.getElementById('lastUpdated').textContent = `Last updated: ${now}`;
}

async function fetchQueue() {
  try {
    const res = await axios.get(`${BACKEND_URL}/queue`);
    const queueContainer = document.getElementById('queue');
    queueContainer.innerHTML = '';

    res.data.forEach((order, idx) => {
      const isNew = !knownIds.has(order.id);
      knownIds.add(order.id);

      const card = document.createElement('div');
      card.className = 'snap-start bg-white shadow rounded-lg p-4 w-80 min-w-[20rem] border-t-4 border-pink-400 flex-shrink-0 transition duration-300';
      if (isNew) card.classList.add('ring-2', 'ring-green-400');

      const userName = order.name || order.from;
      const timeStr = relativeTime(order.createdAt);

      card.innerHTML = `
        <div class="flex justify-between items-center mb-2">
          <h2 class="text-lg font-semibold truncate">${userName}</h2>
          <span class="text-sm text-gray-500">#${idx + 1}</span>
        </div>
        <p class="text-xs text-gray-400 mb-1">${timeStr}</p>
        <ul class="list-disc list-inside text-sm mb-3">
          <li class="font-medium">${order.displayName || order.cocktail}</li>
        </ul>
        <button data-id="${order.id}" class="done-btn bg-green-600 text-white py-1 px-3 rounded hover:bg-green-700 text-sm">Done</button>
      `;

      queueContainer.appendChild(card);

      if (isNew) {
        document.getElementById('newOrderSound').play().catch(() => {});
      }
    });

    document.querySelectorAll('.done-btn').forEach(button => {
      button.addEventListener('click', async () => {
        const id = parseInt(button.getAttribute('data-id'));
        if (!isNaN(id)) await markDone(id);
      });
    });

    updateTimestamp();
  } catch (err) {
    console.error('Failed to fetch queue', err);
    if (err.response && err.response.status === 401) {
      logout();
    }
  }
}

async function markDone(id) {
  try {
    await axios.post(`${BACKEND_URL}/done`, { id });
    fetchQueue();
  } catch (err) {
    console.error('Failed to mark order done', err);
    if (err.response && err.response.status === 401) {
      logout();
    }
  }
}

async function clearQueue() {
  try {
    await axios.post(`${BACKEND_URL}/clear`);
    fetchQueue();
  } catch (err) {
    console.error('Failed to clear queue', err);
    if (err.response && err.response.status === 401) {
      logout();
    }
  }
}

function logout() {
  localStorage.removeItem('jwt');
  const logoutBtn = document.getElementById('logoutBtn');
  logoutBtn.textContent = 'Logging out...';
  setTimeout(() => (window.location.href = '/'), 500);
}

document.getElementById('clearBtn').addEventListener('click', clearQueue);
document.getElementById('stockBtn').addEventListener('click', () => {
  window.location.href = 'stock.html';
});
document.getElementById('refreshBtn').addEventListener('click', fetchQueue);
document.getElementById('logoutBtn').addEventListener('click', logout);

window.onload = () => {
  fetchQueue();
  setInterval(fetchQueue, 5000);
};
