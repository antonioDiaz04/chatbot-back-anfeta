import gradient from "gradient-string";

export const textoColorido = (messages, colors = ["#09bc09", "#3cff00"], modoProduction = false) => {
    if (modoProduction) {
        // Si Modoproduction es true, imprime el mensaje sin degradado ni bordes
        messages.forEach(msg => console.log(msg));
        return;
    }

    const gradientColor = gradient(colors);
    const maxLength = Math.max(...messages.map(msg => msg.length));
    const border = "═".repeat(maxLength + 4);

    console.log(gradientColor(`╔${border}╗`));
    messages.forEach(msg => {
        const padding = " ".repeat(maxLength - msg.length);
        console.log(gradientColor(`║ ${msg}${padding}   ║`));
    });
    console.log(gradientColor(`╚${border}╝`));
};
