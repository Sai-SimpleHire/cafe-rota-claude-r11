# Café rota

A small web app for planning a café's shifts. The manager plans and publishes the week. Staff see only their own shifts on their phone and ask for swaps, which the manager approves or turns down.

## Run it

1. Install **Node.js 22.5 or newer** (the "LTS" version from https://nodejs.org). Nothing else is needed.
2. Open a terminal in this folder and run:

       npm start

3. Open **http://localhost:3000** in your browser.
4. On first use you'll be asked to create the manager account.

Everything is saved in `data/rota.db`. To back up the rota, copy that file. To start again from nothing, stop the app and delete the `data` folder.

To use a different port: `PORT=8080 npm start` (Mac/Linux) or `$env:PORT=8080; npm start` (Windows PowerShell).

## Letting staff use it on their phones

While it runs on your computer, only devices on the same Wi-Fi can reach it, using your computer's local address (for example `http://192.168.1.20:3000`). For staff to use it from anywhere, host it on a small server or a Node hosting service (Render, Railway, Fly.io and so on). Give it a persistent disk for the `data` folder and put it behind HTTPS.

## How it works

- **Manager:** Plan the week (add, change or delete shifts, copy last week, publish or hide), Staff (add, remove, set a new starting password), Swap requests (approve or turn down).
- **Staff:** My shifts (upcoming published shifts, soonest first), Ask for a swap (choose the colleague who will take the shift), withdraw a request.
- A week stays a draft, hidden from staff, until it is published.
- A swap changes the rota only when the manager approves it. Approval is blocked if the colleague already works at that time.
- When a staff member is removed, their account is closed, their shifts from today onwards show as **Unassigned**, and any open swap requests involving them are cancelled.

## Technical notes

- `server.js`: Node.js server with no third-party packages. It uses Node's built-in SQLite database.
- `public/`: the web pages (plain HTML, CSS and JavaScript).
- Passwords are stored hashed with scrypt. Sign-ins use secure HTTP-only cookies, and repeated wrong passwords are slowed down.
