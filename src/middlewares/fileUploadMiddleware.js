import fileUpload from "express-fileupload";

// Middleware para manejar la subida de archivos
const fileUploadMiddleware = fileUpload({
  useTempFiles: true, // Usar archivos temporales
  tempFileDir: "./uploads", // Carpeta temporal para almacenar archivos
});

export default fileUploadMiddleware;