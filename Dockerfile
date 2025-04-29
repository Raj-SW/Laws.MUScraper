# 1) use a real, published Playwright image
FROM mcr.microsoft.com/playwright:v1.52.0-jammy

# 2) make /app our working directory
WORKDIR /app

# 3) copy only the manifest & lockfile, then install
COPY package*.json ./
RUN npm ci

# 4) copy the rest of your code
COPY . .

# 5) when container starts, run your scraper
CMD ["node", "scraper.js"]
