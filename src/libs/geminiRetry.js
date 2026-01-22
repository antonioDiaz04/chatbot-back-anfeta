export async function callGeminiWithRetry(fn, retries = 3, delay = 2000) {
  try {
    return await fn();
  } catch (error) {
    // Detectar si es error de cuota
    if (isGeminiQuotaError(error)) {
      console.warn(`Quota de Gemini agotada. Retry en ${error?.error?.details?.[2]?.retryDelay || 'desconocido'}`);
      throw new Error("Quota de Gemini agotada, usar fallback.");
    }


    // Si es saturación temporal (503 o 429 no por quota)
    const code = error?.error?.code || error?.status;
    if ((code === 503 || code === 429) && retries > 0) {
      console.warn(`Gemini saturado. Reintentando en ${delay}ms...`);
      await new Promise((r) => setTimeout(r, delay));
      return callGeminiWithRetry(fn, retries - 1, delay * 2);
    }

    throw error; // otros errores
  }
}

export function isGeminiQuotaError(error) {
  return (
    error?.error?.status === "RESOURCE_EXHAUSTED" ||
    error?.status === "RESOURCE_EXHAUSTED" ||
    error?.message?.includes("Quota exceeded") ||
    error?.message?.includes("RESOURCE_EXHAUSTED")
  );
}
