import axios from "axios";

const urlApi = "https://wlserver-production-6735.up.railway.app";

export const getAllUsers = async () => {
  try {
    const response = await axios.get(`${urlApi}/users/search`);

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
