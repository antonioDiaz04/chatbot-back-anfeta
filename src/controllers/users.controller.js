import axios from "axios";
import { API_URL_ANFETA } from "../config.js";

export const getAllUsers = async () => {
  try {
    const response = await axios.get(`${API_URL_ANFETA}/users/search`);

    const usersClean = response.data.items.map(user => ({
      id: user.collaboratorId,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
    }));

    return {
      items: usersClean
    };

  } catch (error) {
    console.error("Error obteniendo usuarios:", error.message);
    throw error;
  }
};
