# ─────────────────────────────────────────────────────────────────────────────
# 1) Base image includes Node.js, Playwright browsers & required OS packages
FROM mcr.microsoft.com/playwright:v1.52.0-focal

# ─────────────────────────────────────────────────────────────────────────────
# 2) Create app directory
WORKDIR /app

# ─────────────────────────────────────────────────────────────────────────────
# 3) Copy package manifest & install dependencies
#    This also triggers Playwright’s install hooks (browsers already present).
COPY package*.json ./
RUN npm ci

# ─────────────────────────────────────────────────────────────────────────────
# 4) Copy your scraper code
COPY . .

# ─────────────────────────────────────────────────────────────────────────────
# 5) Launch your scraper when container starts
CMD ["node", "scraper.js"]
