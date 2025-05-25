FROM mcr.microsoft.com/playwright:v1.52.0-jammy

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# ✅ Tell Playwright to use the preinstalled browser path
ENV PLAYWRIGHT_BROWSERS_PATH=/ms/playwright

EXPOSE 10000

CMD ["npm", "start"]
