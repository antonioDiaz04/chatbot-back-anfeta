import sanitizeHtml from "sanitize-html";

/**
 * Función para sanitizar objetos.
 * @param {Object} obj - El objeto a sanitizar.
 * @returns {Object} - El objeto sanitizado.
 */

export const sanitizeObject = (obj) => {
    Object.keys(obj).forEach(key => {
        if (typeof obj[key] === 'string') {
            obj[key] = sanitizeHtml(obj[key]);
        }
    });
    return obj;
};