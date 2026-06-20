def connect_database(path):
    return {"path": path}


def save_user(connection, user):
    return {"connection": connection, "user": user}
