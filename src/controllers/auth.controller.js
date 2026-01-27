import jwt from "jsonwebtoken";
import { TOKEN_SECRET } from "../config.js";
import { createAccessToken } from "../libs/jwt.js";
import { getAllUsers } from "./users.controller.js";

export const signIn = async (req, res) => {
  try {
    const { email } = req.body;
    const users = await getAllUsers();

    const userFound = users.items.find(
      u => u.email.toLowerCase() === email.toLowerCase()
    );

    if (!userFound) {
      return res.status(400).json({
        message: ["El usuario no existe"]
      });
    }


    const token = await createAccessToken({
      id: userFound.collaboratorId,
      email: userFound.email,
      username: userFound.firstName,
    });

    res.cookie("token", token, {
      httpOnly: process.env.NODE_ENV !== "development",
      sameSite: "lax",    // NO "none" en http
      secure: false,      // para que pueda secibir el http
      path: "/"
      // secure: true, //para https
      // sameSite: "none",
    });

    res.json({
      id: userFound.collaboratorId,
      username: userFound.firstName,
      email: userFound.email,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const verifyToken = (req, res) => {
  const { token } = req.cookies;

  if (!token) return res.sendStatus(401);

  jwt.verify(token, TOKEN_SECRET, (error, user) => {
    if (error) return res.sendStatus(401);

    return res.json({
      id: user.id,
      email: user.email,
      username: user.username
    });
  });
};

export const logout = async (req, res) => {
  res.cookie("token", "", {
    httpOnly: true,
    // secure: true,
    expires: new Date(0),
  });
  return res.sendStatus(200);
};
