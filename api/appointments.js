export default function handler(_request, response) {
  return response.status(410).json({
    error: 'This legacy endpoint is disabled. Use the authenticated Firebase booking service.',
  });
}
