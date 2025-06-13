const BACKEND_URL = 'https://whatsapp-cocktail-bot.onrender.com';

document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = document.getElementById('passwordInput').value.trim();
  try {
    const res = await axios.post(`${BACKEND_URL}/login`, { password });
    localStorage.setItem('jwt', res.data.token);
    window.location.href = '/dashboard.html';
  } catch (err) {
    document.getElementById('errorMsg').classList.remove('hidden');
  }
});
