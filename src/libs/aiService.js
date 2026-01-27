
import Groq from "groq-sdk";
import { GoogleGenAI } from '@google/genai';
import { GEMINI_API_KEY, GROQ_API_KEY_1, GROQ_API_KEY_2 } from '../config.js';
import { isGeminiQuotaError } from './geminiRetry.js';
import { callGeminiWithRetry } from './geminiRetry.js';

// Configuración de Instancias
const genAI = new GoogleGenAI({
    apiKey: GEMINI_API_KEY,
});

const clavesValidas = [GROQ_API_KEY_1, GROQ_API_KEY_2].filter(key => key && key.trim() !== "");


// Crear el pool solo con las que sí existen
const poolGroq = clavesValidas.map(key => new Groq({ apiKey: key }));
let indiceActual = 0;


/**
 * Intenta obtener respuesta de las cuentas de Groq de forma rotativa
 */
async function llamarGroqConRespaldo(prompt) {
    for (let i = 0; i < poolGroq.length; i++) {
        const instancia = poolGroq[indiceActual];
        const numCuenta = indiceActual + 1;
        indiceActual = (indiceActual + 1) % poolGroq.length;

        try {
            const completion = await instancia.chat.completions.create({
                messages: [{ role: "user", content: prompt }],
                model: "llama-3.1-8b-instant",
            });
            return {
                text: completion.choices[0].message.content,
                provider: `Groq`
            };
        } catch (error) {
            // Si es error de cuota (429) y tenemos más cuentas, continuamos
            if (error.status === 429 && i < poolGroq.length - 1) {
                console.warn(`Groq Cuenta ${numCuenta} saturada, rotando...`);
                continue;
            }
            throw error;
        }
    }
}

/**
 * Función principal de llamada inteligente (Gemini -> Groq Pool)
 */
/**
 * Función principal de llamada inteligente (Groq Pool -> Gemini Backup)
 */
export async function smartAICall(prompt) {
    // 1. INTENTO PRINCIPAL: Pool de Groq
    console.log("🚀 Iniciando petición con Groq (Prioridad Alta)...");
    try {
        const groqResult = await llamarGroqConRespaldo(prompt);
        return groqResult; // Si funciona, termina aquí.
    } catch (groqError) {
        console.error("⚠️ Falló el pool de Groq o todas las cuentas están saturadas.");
        
        // 2. RESPALDO (FAILOVER): Gemini
        console.warn("🔄 Entrando a Gemini como respaldo de emergencia...");
        try {
            const geminiResult = await callGeminiWithRetry(async () => {
                const model = genAI.getGenerativeModel({ 
                    model: 'gemini-1.5-flash' // El 2.5-lite es experimental, 1.5-flash es más estable
                });
                const response = await model.generateContent(prompt);
                return { 
                    text: response.response.text(), 
                    provider: 'Gemini (Backup)' 
                };
            }, 1); // Solo un reintento para no perder tiempo si los tokens están agotados

            return geminiResult;
        } catch (geminiError) {
            console.error("❌ CRÍTICO: Falló Groq y también falló Gemini.");
            
            // Si llegamos aquí, realmente no hay servicio disponible
            throw new Error("AI_PROVIDER_FAILED");
        }
    }
}