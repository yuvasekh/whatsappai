# Use the official Playwright image with Node.js and all dependencies pre-installed
FROM mcr.microsoft.com/playwright:v1.52.0-jammy

# Set working directory
WORKDIR /app

# Copy package files first for better Docker layer caching
COPY package*.json ./

# Install npm dependencies
RUN npm install

# Install Playwright browsers explicitly
RUN npx playwright install chromium

# Copy the rest of the application files
COPY . .

# Create necessary directories if they don't exist
RUN mkdir -p server build node_modules

# Expose the port your app runs on
EXPOSE 10000

# Set environment variables for Playwright
ENV PLAYWRIGHT_BROWSERS_PATH=/ms/playwright
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=0

# Start the application
CMD ["npm", "start"]